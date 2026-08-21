// api/success.js — standalone Vercel serverless function
// Handles HandyPay post-payment redirect: /success?session_id=...
// FIX: only fires record-payment for ghl_native sessions
//      deposit/full sessions get tag+note on contact ONLY (no invoice to mark)
// FIX 2: Added frame-ancestors * CSP so this page loads inside GHL iframe after redirect.
//        Sends custom_element_success_response directly (api/pay listener is gone after redirect).
'use strict';

const { Pool } = require('pg');

const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_CLIENT_ID = process.env.GHL_CLIENT_ID;
const GHL_CLIENT_SECRET = process.env.GHL_CLIENT_SECRET;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------- DB helpers ----------
async function getMerchantConfig(locationId) {
  const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [locationId]);
  return rows[0] || null;
}
async function getPaymentLogBySession(sessionId) {
  const { rows } = await pool.query('SELECT * FROM payment_logs WHERE session_id=$1', [sessionId]);
  return rows[0] || null;
}
async function markPaid(sessionId) {
  await pool.query('UPDATE payment_logs SET status=$1, updated_at=NOW() WHERE session_id=$2', ['paid', sessionId]);
}

// ---------- Token helpers ----------
async function refreshCrmToken(locationId) {
  const cfg = await getMerchantConfig(locationId);
  const refreshTok = (cfg && (cfg.crm_refresh_token || cfg.ghl_refresh_token)) || '';
  if (!refreshTok) throw new Error('No refresh token');
  const r = await fetch(GHL_API + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GHL_CLIENT_ID, client_secret: GHL_CLIENT_SECRET,
      grant_type: 'refresh_token', refresh_token: refreshTok
    })
  });
  if (!r.ok) throw new Error('Token refresh ' + r.status);
  const data = await r.json();
  await pool.query(
    'UPDATE merchant_configs SET crm_access_token=$1,crm_refresh_token=$2,updated_at=NOW() WHERE location_id=$3',
    [data.access_token, data.refresh_token, locationId]
  );
  return data.access_token;
}
async function getFreshToken(locationId) {
  const cfg = await getMerchantConfig(locationId).catch(function() { return null; });
  if (!cfg) return '';
  let tok = cfg.crm_access_token || cfg.ghl_access_token || '';
  // PIT mode: no refresh token = permanent token, never expires
  if (!cfg.crm_refresh_token && !cfg.ghl_refresh_token) return tok;
  try { const fresh = await refreshCrmToken(locationId); if (fresh) tok = fresh; } catch (e) {}
  return tok;
}

// ---------- CRM helpers ----------
async function addContactTag(token, contactId, tags) {
  const r = await fetch(GHL_API + '/contacts/' + contactId + '/tags', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Version: '2021-07-28' },
    body: JSON.stringify({ tags: tags })
  });
  if (!r.ok) console.error('[success] tag failed:', r.status);
}
async function addContactNote(token, contactId, body) {
  const r = await fetch(GHL_API + '/contacts/' + contactId + '/notes', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Version: '2021-07-28' },
    body: JSON.stringify({ body: body })
  });
  if (!r.ok) console.error('[success] note failed:', r.status);
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
        body: JSON.stringify({ altId: locationId, altType: 'location', amount: amount, mode: 'card', notes: note })
      });
      const rpText = await rp.text();
      console.log('[success] record-payment attempt', attempt, invoiceId, rp.status, rpText.substring(0, 80));
      if (rp.status === 409 && attempt < 3) {
        await new Promise(function(resolve) { setTimeout(resolve, 1500 * attempt); });
        continue;
      }
      return rp.status;
    } catch (e) { console.error('[success] record-payment err:', e.message); return 0; }
  }
  return 0;
}

// ---------- Main handler ----------
module.exports = async function handler(req, res) {
  const sessionId = (req.query && (req.query.session_id || req.query.sessionId)) || '';

  if (sessionId) {
    try {
      await markPaid(sessionId);
      const sLog = await getPaymentLogBySession(sessionId);

      if (sLog && sLog.location_id) {
        const tok = await getFreshToken(sLog.location_id);
        if (tok) {
          const isGhlNative = sLog.payment_type === 'ghl_native';

          if (isGhlNative) {
            // INVOICE FLOW: fire record-payment as backup
            // Primary path: postMessage below + GHL verify polling via /api/query
            let invId = (req.query && req.query.inv) || sLog.entity_id || '';
            if (!invId && sLog.ghl_transaction_id) {
              invId = await getInvoiceIdByTx(sLog.location_id, sLog.ghl_transaction_id, tok)
                .catch(function() { return ''; });
              if (invId) console.log('[success] tx->inv:', sLog.ghl_transaction_id, '->', invId);
            }
            if (invId) {
              // fire-and-forget backup; GHL polling via /api/query is the primary path
              fireRecordPayment(invId, sLog.location_id, sLog.amount, 'HandyPay:' + sessionId, tok)
                .catch(function(e) { console.error('[success] record-payment fire err:', e.message); });
            } else {
              console.log('[success] ghl_native: no invId for session', sessionId);
            }
          } else {
            // DEPOSIT / FULL / CALENDAR FLOW: tag + note on contact
            // NO record-payment call — deposits are standalone, not tied to a GHL invoice
            if (sLog.contact_id) {
              await addContactTag(tok, sLog.contact_id, ['deposit-paid'])
                .catch(function(e) { console.error('[success] tag err:', e.message); });
              await addContactNote(tok, sLog.contact_id, (sLog.payment_type || 'deposit') + ' paid via HandyPay: ' + sLog.amount + ' JMD')
                .catch(function(e) { console.error('[success] note err:', e.message); });
            }
          }
        }
      }
    } catch (err) {
      console.error('[success] top-level err:', err.message);
    }
  }

  // Allow loading inside GHL iframe after location.href redirect
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Type', 'text/html');

  // Respond with confirmation page + postMessage to GHL iframe parent
  // IMPORTANT: api/pay.js is gone after the redirect, so we send
  // custom_element_success_response directly from here.
  var sid = JSON.stringify(sessionId);
  var scriptContent = 'var s=' + sid + ';' +
    'if(s){try{' +
    // GHL custom payment provider required success signal
    'window.parent.postMessage(JSON.stringify({type:"custom_element_success_response",chargeId:s}),"*");' +
    'window.parent.postMessage({type:"custom_element_success_response",chargeId:s},"*");' +
    // Legacy / fallback signals
    'window.parent.postMessage({type:"PAYMENT_SUCCESS",paymentIntentId:s,status:"succeeded"},"*");' +
    'window.parent.postMessage({event:"payment-success",paymentIntentId:s},"*");' +
    'if(window.opener){window.opener.postMessage({type:"PAYMENT_SUCCESS",paymentIntentId:s,status:"succeeded"},"*");setTimeout(function(){try{window.close();}catch(e){}},2000);}' +
    'window.parent.postMessage({success:true,paymentIntentId:s,orderId:s},"*");' +
    '}catch(e){}}' +
    'setTimeout(function(){try{' +
    // GHL close signal
    'window.parent.postMessage(JSON.stringify({type:"custom_element_close_response"}),"*");' +
    'window.parent.postMessage({type:"custom_element_close_response"},"*");' +
    'window.parent.postMessage({type:"PAYMENT_COMPLETE",paymentIntentId:s},"*");' +
    '}catch(e){}},1500);';

  res.end('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Confirmed</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0fdf4;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;width:100%;padding:40px;text-align:center}.icon{font-size:64px;margin-bottom:16px}h1{font-size:22px;font-weight:800;color:#15803d;margin-bottom:10px}p{font-size:15px;color:#555;line-height:1.6}.sub{font-size:13px;color:#888;margin-top:20px}</style></head><body><div class="card"><div class="icon">&#x2705;</div><h1>Payment Confirmed!</h1><p>Thank you. Your payment was received successfully.</p><p class="sub">You may close this window.</p></div><script>' + scriptContent + '<\/script></body></html>');
};
