// api/admin.js — Consolidated admin functions
// Merges: cron-retry + fix-db + refresh-token into ONE Vercel function
// to free up function slots on the Hobby plan (12/12 limit).
// Sub-route via ?action= : cron | fixdb | refresh
'use strict';
const { Pool } = require('pg');

const GHL_API = 'https://services.leadconnectorhq.com';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000
});

function authed(req) {
  const secret = (req.query && req.query.secret) || (req.headers['authorization'] || '').replace('Bearer ', '');
  return secret === process.env.INIT_SECRET || secret === 'handypay-init-2026-lnet';
}

// ── cron-retry ────────────────────────────────────────────────
async function cronRetry(req, res) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM payment_logs WHERE status='paid'" +
      " AND payment_type = 'ghl_native'" +
      " AND (record_payment_done IS NULL OR record_payment_done = FALSE)" +
      " AND created_at < NOW() - INTERVAL '3 minutes'" +
      " AND created_at > NOW() - INTERVAL '60 minutes'" +
      " AND location_id IS NOT NULL LIMIT 10"
    );
    const results = [];
    for (const row of rows) {
      const cfg = (await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [row.location_id]).catch(() => ({ rows: [] }))).rows[0];
      let tok = (cfg && cfg.crm_access_token) || '';
      let invId = row.entity_id || '';
      if (!invId && row.ghl_transaction_id && tok) {
        try {
          const r = await fetch(GHL_API + '/payments/transactions?altId=' + row.location_id + '&altType=location&id=' + row.ghl_transaction_id, { headers: { Authorization: 'Bearer ' + tok, Version: '2021-07-28' } });
          const d = await r.json();
          invId = (d.data && d.data[0] && d.data[0].entityId) || '';
        } catch (e) {}
      }
      if (invId && tok) {
        let rpStatus = 0;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const rp = await fetch(GHL_API + '/invoices/' + invId + '/record-payment', {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Version: '2021-07-28' },
              body: JSON.stringify({ altId: row.location_id, altType: 'location', amount: row.amount, mode: 'card', notes: 'HandyPay-cron:' + row.session_id })
            });
            rpStatus = rp.status;
            if (rpStatus === 409 && attempt < 3) { await new Promise(res => setTimeout(res, 1500 * attempt)); continue; }
            break;
          } catch (e) { rpStatus = 0; break; }
        }
        if (rpStatus === 201 || rpStatus === 200 || rpStatus === 400) {
          await pool.query('UPDATE payment_logs SET record_payment_done=TRUE, updated_at=NOW() WHERE session_id=$1', [row.session_id]).catch(() => {});
          results.push({ session: row.session_id, status: 'done', invoiceId: invId, code: rpStatus });
        } else if (rpStatus === 409) {
          results.push({ session: row.session_id, status: 'still_locked', invoiceId: invId });
        } else {
          results.push({ session: row.session_id, status: 'failed', code: rpStatus, invoiceId: invId });
        }
      } else {
        results.push({ session: row.session_id, status: 'skipped', reason: !invId ? 'no-invoiceId' : 'no-token' });
      }
    }
    return res.json({ ran_at: new Date().toISOString(), processed: rows.length, results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── fix-db (indexes + debug_messages cleanup) ─────────────────
async function fixDb(req, res) {
  const results = {}, errors = {};
  const run = async (name, fn) => { try { await fn(); results[name] = 'ok'; } catch (e) { errors[name] = e.message; } };
  await run('idx_session_id', () => pool.query('CREATE INDEX IF NOT EXISTS idx_pl_session_id ON payment_logs(session_id)'));
  await run('idx_location_id', () => pool.query('CREATE INDEX IF NOT EXISTS idx_pl_location_id ON payment_logs(location_id)'));
  await run('idx_status', () => pool.query('CREATE INDEX IF NOT EXISTS idx_pl_status ON payment_logs(status)'));
  await run('idx_loc_status_ts', () => pool.query('CREATE INDEX IF NOT EXISTS idx_pl_loc_status_ts ON payment_logs(location_id, status, created_at DESC)'));
  try {
    const c = await pool.query('SELECT COUNT(*)::int AS n FROM debug_messages');
    const before = c.rows[0].n;
    if (before > 500) {
      await pool.query('DELETE FROM debug_messages WHERE id NOT IN (SELECT id FROM debug_messages ORDER BY id DESC LIMIT 500)');
    }
    const after = (await pool.query('SELECT COUNT(*)::int AS n FROM debug_messages')).rows[0].n;
    results.debug_messages = { before, after, deleted: before - after };
  } catch (e) { errors.debug_messages = e.message; }
  try { results.payment_logs_rows = (await pool.query('SELECT COUNT(*)::int AS n FROM payment_logs')).rows[0].n; } catch (e) { errors.payment_logs_rows = e.message; }
  try { results.merchant_configs_rows = (await pool.query('SELECT COUNT(*)::int AS n FROM merchant_configs')).rows[0].n; } catch (e) { errors.merchant_configs_rows = e.message; }
  const hasErrors = Object.keys(errors).length > 0;
  return res.status(hasErrors ? 207 : 200).json({ ok: !hasErrors, ts: new Date().toISOString(), results, errors: hasErrors ? errors : undefined });
}

// ── refresh-token (with PIT mode) ─────────────────────────────
async function refreshToken(req, res) {
  const locationId = req.query.locationId;
  if (!locationId) return res.status(400).json({ error: 'locationId required' });
  try {
    const { rows } = await pool.query('SELECT crm_refresh_token, crm_access_token FROM merchant_configs WHERE location_id=$1', [locationId]);
    if (!rows[0]) return res.status(404).json({ error: 'no merchant config found for this location' });
    if (req.query.manual_token) {
      const hasManualRefresh = Object.prototype.hasOwnProperty.call(req.query, 'manual_refresh');
      const newRefresh = hasManualRefresh ? (req.query.manual_refresh || null) : (rows[0].crm_refresh_token || null);
      await pool.query('UPDATE merchant_configs SET crm_access_token=$1, crm_refresh_token=$2 WHERE location_id=$3', [req.query.manual_token, newRefresh, locationId]);
      const mode = newRefresh ? 'oauth_manual' : 'pit_manual';
      return res.json({ success: true, mode, message: mode === 'pit_manual' ? 'Token stored as permanent PIT — no future refresh needed.' : 'Token manually stored. Will auto-refresh using stored refresh_token.' });
    }
    if (!rows[0].crm_refresh_token) {
      return res.json({ success: true, mode: 'pit', message: 'PIT mode — GHL Private Integration Token in use. No refresh needed. Token is permanent.' });
    }
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', process.env.GHL_CLIENT_ID);
    params.append('client_secret', process.env.GHL_CLIENT_SECRET);
    params.append('refresh_token', rows[0].crm_refresh_token);
    params.append('redirect_uri', (process.env.APP_URL || 'https://handypay-deposits-app.vercel.app') + '/api/oauth/callback');
    const tokenRes = await fetch(GHL_API + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return res.json({ success: false, status: tokenRes.status, error: 'GHL token refresh failed', details: tokenData });
    }
    await pool.query('UPDATE merchant_configs SET crm_access_token=$1, crm_refresh_token=$2 WHERE location_id=$3', [tokenData.access_token, tokenData.refresh_token || rows[0].crm_refresh_token, locationId]);
    return res.json({ success: true, mode: 'auto_refresh', message: 'Token refreshed and saved to DB', expires_in: tokenData.expires_in });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── MAIN ──────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (!authed(req)) return res.status(403).json({ error: 'forbidden' });
  const action = (req.query && req.query.action) || '';
  if (action === 'cron') return cronRetry(req, res);
  if (action === 'fixdb') return fixDb(req, res);
  if (action === 'refresh') return refreshToken(req, res);
  return res.status(400).json({ error: 'action required: cron | fixdb | refresh' });
};
