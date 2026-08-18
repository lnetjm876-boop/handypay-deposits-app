// api/cron-retry.js — standalone Vercel serverless function
// Retries GHL record-payment for sessions paid 3-60 min ago (bypasses 409 lock)
// PIT mode: locations with no crm_refresh_token use a permanent GHL API key (no rotation)
'use strict';
const { Pool } = require('pg');

const GHL_API = 'https://services.leadconnectorhq.com';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function getMerchantConfig(locationId) {
  const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [locationId]);
  return rows[0] || null;
}

async function refreshCrmToken(locationId) {
  const cfg = await getMerchantConfig(locationId);
  const refreshTok = (cfg && cfg.crm_refresh_token) || (cfg && cfg.ghl_refresh_token) || '';
  if (!cfg || !refreshTok) throw new Error('No refresh token for ' + locationId);
  const r = await fetch(GHL_API + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GHL_CLIENT_ID,
      client_secret: process.env.GHL_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshTok
    })
  });
  if (!r.ok) throw new Error('Token refresh failed: ' + r.status);
  const data = await r.json();
  await pool.query(
    'UPDATE merchant_configs SET crm_access_token=$1, crm_refresh_token=$2, ghl_access_token=$1, ghl_refresh_token=$2, updated_at=NOW() WHERE location_id=$3',
    [data.access_token, data.refresh_token, locationId]
  );
  return data.access_token;
}

async function getFreshToken(locationId) {
  const cfg = await getMerchantConfig(locationId).catch(() => null);
  if (!cfg) return '';
  const tok = cfg.crm_access_token || cfg.ghl_access_token || '';
  // PIT mode: no refresh token stored = GHL Private Integration Token (never expires)
  // Skip the OAuth refresh attempt entirely — just return the stored permanent token
  const refreshTok = cfg.crm_refresh_token || cfg.ghl_refresh_token || '';
  if (!refreshTok) {
    console.log('[cron] PIT mode for', locationId, '— using permanent token');
    return tok;
  }
  // OAuth mode: try to refresh, fall back to stored token
  try { const fresh = await refreshCrmToken(locationId); if (fresh) return fresh; } catch (e) {
    console.log('[cron] token refresh skipped:', e.message, '— using stored token');
  }
  return tok;
}

async function getInvoiceIdByTx(locationId, txId, token) {
  if (!txId || !token) return '';
  try {
    const r = await fetch(
      GHL_API + '/payments/transactions?altId=' + locationId + '&altType=location&id=' + txId,
      { headers: { Authorization: 'Bearer ' + token, Version: '2021-07-28' } }
    );
    const d = await r.json();
    return (d.data && d.data[0] && d.data[0].entityId) || '';
  } catch (e) { return ''; }
}

async function fireRecordPayment(invoiceId, locationId, amount, note, token) {
  if (!invoiceId || !token) return 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const rp = await fetch(GHL_API + '/invoices/' + invoiceId + '/record-payment', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Version: '2021-07-28' },
        body: JSON.stringify({ altId: locationId, altType: 'location', amount, mode: 'card', notes: note })
      });
      const rpText = await rp.text();
      console.log('[cron] fireRecordPayment attempt', attempt, invoiceId, rp.status, rpText.substring(0, 80));
      if (rp.status === 409 && attempt < 3) {
        await new Promise(res => setTimeout(res, 1500 * attempt));
        continue;
      }
      return rp.status;
    } catch (e) { console.error('[cron] fireRecordPayment err:', e.message); return 0; }
  }
  return 0;
}

module.exports = async function handler(req, res) {
  const sec = (req.query || {}).secret;
  if (sec !== process.env.INIT_SECRET) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { rows } = await pool.query(
      "SELECT * FROM payment_logs WHERE status='paid'" +
      " AND created_at < NOW() - INTERVAL '3 minutes'" +
      " AND created_at > NOW() - INTERVAL '60 minutes'" +
      " AND location_id IS NOT NULL LIMIT 10"
    );
    const results = [];
    for (const row of rows) {
      let invId = row.entity_id || row.appointment_id || '';
      const tok = await getFreshToken(row.location_id).catch(() => '');
      if (!invId && row.ghl_transaction_id && tok) {
        invId = await getInvoiceIdByTx(row.location_id, row.ghl_transaction_id, tok);
      }
      if (invId && tok) {
        const rpStatus = await fireRecordPayment(
          invId, row.location_id, row.amount,
          'HandyPay-cron:' + row.session_id, tok
        );
        if (rpStatus === 201 || rpStatus === 200) {
          results.push({ session: row.session_id, status: 'done', invoiceId: invId });
        } else if (rpStatus === 409) {
          results.push({ session: row.session_id, status: 'still_locked', invoiceId: invId });
        } else {
          results.push({ session: row.session_id, status: 'failed', code: rpStatus, invoiceId: invId });
        }
      } else {
        results.push({
          session: row.session_id,
          status: 'skipped',
          reason: !invId ? 'no-invoiceId' : 'no-token'
        });
      }
    }
    return res.json({ ran_at: new Date().toISOString(), processed: rows.length, results });
  } catch (err) {
    console.error('[cron] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}