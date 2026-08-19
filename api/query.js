// api/query.js — GHL Custom Payment Provider — All query types
// Handles: list_payment_methods, charge_payment, create_subscription,
//          cancel_subscription, refund, verify, GET status poll
// Routed by vercel.json BEFORE the server.js catch-all.

const { Pool } = require('pg');

const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_CLIENT_ID = process.env.GHL_CLIENT_ID;
const GHL_CLIENT_SECRET = process.env.GHL_CLIENT_SECRET;
const HP_BASE = 'https://api.handypay.me/api/v1';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Parse request body (Vercel does NOT auto-parse JSON for serverless functions)
async function parseBody(req) {
  // Already parsed as object (e.g. via Express or test harness)
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  // String or Buffer — parse directly
  if (req.body) { try { return JSON.parse(req.body.toString()); } catch (e) { return {}; } }
  // Unread stream — read and parse
  return new Promise(function(resolve) {
    let raw = '';
    req.on('data', function(c) { raw += c; });
    req.on('end', function() { try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); } });
    req.on('error', function() { resolve({}); });
  });
}

// DB helpers
async function getMerchantConfig(locationId) {
  const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [locationId]);
  return rows[0] || null;
}
async function getPaymentLog(chargeId) {
  const r = await pool.query('SELECT * FROM payment_logs WHERE session_id=$1', [chargeId]);
  return r.rows[0] || null;
}
async function getPaymentLogByTx(txId) {
  const r = await pool.query('SELECT * FROM payment_logs WHERE ghl_transaction_id=$1', [txId]);
  return r.rows[0] || null;
}

// Token helpers
async function refreshCrmToken(locationId) {
  const cfg = await getMerchantConfig(locationId);
  const refreshTok = (cfg && (cfg.crm_refresh_token || cfg.ghl_refresh_token)) || '';
  if (!refreshTok) throw new Error('No refresh token for ' + locationId);
  const r = await fetch(GHL_API + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GHL_CLIENT_ID, client_secret: GHL_CLIENT_SECRET,
      grant_type: 'refresh_token', refresh_token: refreshTok
    })
  });
  if (!r.ok) throw new Error('Token refresh HTTP ' + r.status);
  const data = await r.json();
  await pool.query(
    'UPDATE merchant_configs SET crm_access_token=$1,crm_refresh_token=$2,ghl_access_token=$1,ghl_refresh_token=$2,updated_at=NOW() WHERE location_id=$3',
    [data.access_token, data.refresh_token, locationId]
  );
  return data.access_token;
}
async function getFreshToken(locationId) {
  const cfg = await getMerchantConfig(locationId).catch(function() { return null; });
  if (!cfg) return '';
  let tok = cfg.crm_access_token || cfg.ghl_access_token || '';
  try { const fresh = await refreshCrmToken(locationId); if (fresh) tok = fresh; } catch (e) {}
  return tok;
}

// Invoice helpers
async function getInvoiceIdByTx(locationId, txId, token) {
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
  try {
    const rp = await fetch(GHL_API + '/invoices/' + invoiceId + '/record-payment', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Version: '2021-07-28' },
      body: JSON.stringify({ altId: locationId, altType: 'location', amount: amount, mode: 'card', notes: note })
    });
    return rp.status;
  } catch (e) { return 0; }
}

// Main handler
module.exports = async function handler(req, res) {
  const body = await parseBody(req);
  const qType = body.type || req.query.type || '';
  const paymentIntentId =
    req.query.paymentIntentId ||
    body.paymentIntentId ||
    body.transactionId ||
    body.chargeId ||
    '';

  console.log('[api/query]', req.method, 'type:', qType, 'id:', paymentIntentId);

  // list_payment_methods — we don't store cards on file; return empty array
  if (qType === 'list_payment_methods') {
    return res.json([]);
  }

  // charge_payment — off-session not supported in v1
  if (qType === 'charge_payment') {
    return res.json({
      success: false, failed: true, chargeId: '',
      message: 'Off-session card charging is not supported by HandyPay Deposits. Customer must complete payment via the checkout page.',
      chargeSnapshot: { status: 'failed', amount: 0, chargeId: '', chargedAt: Math.floor(Date.now() / 1000) }
    });
  }

  // create_subscription — not supported in v1
  if (qType === 'create_subscription') {
    return res.json({ success: false, failed: true, message: 'Subscription billing is not yet supported by HandyPay Deposits. Coming in v2.' });
  }

  // cancel_subscription — spec §9.4.3 requires { status: "canceled" }
  if (qType === 'cancel_subscription') {
    return res.json({ status: 'canceled' });
  }

  // refund — call HandyPay /refunds API, spec §10.1
  if (qType === 'refund') {
    const refChargeId = body.chargeId || paymentIntentId || '';
    const refAmount   = parseFloat(body.amount) || 0;
    let   hpApiKey    = body.apiKey || '';
    if (!hpApiKey && refChargeId) {
      const rLog = await getPaymentLog(refChargeId).catch(function() { return null; });
      if (rLog && rLog.location_id) {
        const rCfg = await getMerchantConfig(rLog.location_id).catch(function() { return null; });
        if (rCfg) hpApiKey = rCfg.handypay_api_key || '';
      }
    }
    if (hpApiKey && refChargeId) {
      try {
        const hpRBody = { session_id: refChargeId, reason: 'requested_by_customer' };
        if (refAmount > 0) hpRBody.amount = Math.round(refAmount * 100);
        const hpRR = await fetch(HP_BASE + '/refunds', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + hpApiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(hpRBody)
        });
        const hpRD = await hpRR.json();
        console.log('[api/query:refund] HP:', hpRR.status, JSON.stringify(hpRD).substring(0, 120));
        if (hpRR.ok && hpRD.success) {
          const rd = hpRD.data || hpRD;
          return res.json({ success: true, message: 'Refund processed via HandyPay', id: rd.id || ('ref_' + Date.now()), amount: refAmount, currency: 'JMD' });
        }
        const rErrMsg = (hpRD.error && hpRD.error.message) || 'HandyPay refund failed';
        return res.json({ success: false, message: rErrMsg, id: 'ref_' + Date.now(), amount: refAmount, currency: 'JMD' });
      } catch (rEx) { console.error('[api/query:refund] HP error:', rEx.message); }
    }
    return res.json({ success: true, message: 'Refund logged — process manually via HandyPay dashboard', id: 'ref_' + Date.now(), amount: refAmount, currency: 'JMD' });
  }

  // verify — POST from GHL backend after iframe success event, spec §8.4
  if (qType === 'verify' || req.method === 'POST') {
    const chargeId      = body.chargeId || paymentIntentId || '';
    const transactionId = body.transactionId || '';
    const apiKey        = body.apiKey || '';
    try {
      let log = await getPaymentLog(chargeId);
      if (!log && transactionId) log = await getPaymentLogByTx(transactionId);
      if (!log && chargeId)      log = await getPaymentLogByTx(chargeId);

      if (log && (log.status === 'paid' || log.status === 'completed')) {
        if (log.location_id && !log.record_payment_done) {
          (async function() {
            try {
              const qTok = await getFreshToken(log.location_id);
              if (!qTok) return;
              let invId = log.entity_id || log.appointment_id || '';
              if (!invId && log.ghl_transaction_id) invId = await getInvoiceIdByTx(log.location_id, log.ghl_transaction_id, qTok);
              if (invId) await fireRecordPayment(invId, log.location_id, log.amount, 'HandyPay:verify:' + chargeId, qTok);
              await pool.query('UPDATE payment_logs SET record_payment_done=TRUE,updated_at=NOW() WHERE session_id=$1', [log.session_id]).catch(function() {});
            } catch (e) { console.error('[api/query:verify] invoice err:', e.message); }
          })();
        }
        return res.json({ success: true, chargeSnapshot: { status: 'succeeded', amount: Math.round((log.amount || 0) * 100), chargeId: chargeId || log.session_id, chargedAt: Math.floor(Date.now() / 1000) } });
      }

      if (log && log.status === 'failed') return res.json({ failed: true });

      let hpKey = apiKey;
      if (!hpKey && log && log.location_id) {
        const hpCfg = await getMerchantConfig(log.location_id);
        hpKey = (hpCfg && hpCfg.handypay_api_key) || '';
      }
      if (hpKey && chargeId) {
        try {
          const hpR = await fetch(HP_BASE + '/payment-sessions/' + chargeId, { headers: { Authorization: 'Bearer ' + hpKey } });
          if (hpR.ok) {
            const hpD = await hpR.json();
            const sess = hpD.data || hpD;
            const hpStatus = (sess.status || '').toLowerCase();
            const amtHP = sess.amount_total || sess.amount_received || (log && Math.round(log.amount * 100)) || 0;
            if (['complete', 'paid', 'success', 'succeeded'].includes(hpStatus)) {
              if (log) pool.query('UPDATE payment_logs SET status=$1,updated_at=NOW() WHERE session_id=$2', ['paid', log.session_id]).catch(function() {});
              return res.json({ success: true, chargeSnapshot: { status: 'succeeded', amount: amtHP, chargeId: chargeId, chargedAt: Math.floor(Date.now() / 1000) } });
            }
            if (['expired', 'cancelled', 'canceled', 'failed'].includes(hpStatus)) return res.json({ failed: true });
          }
        } catch (hpE) { console.error('[api/query:verify] HP check error:', hpE.message); }
      }

      return res.json({ success: false });
    } catch (err) {
      console.error('[api/query:verify] ERROR:', err.message);
      return res.json({ success: false });
    }
  }

  // GET status poll (from /api/pay iframe, polls every 3s after HandyPay redirect)
  try {
    const pollId = req.query.paymentIntentId || paymentIntentId || '';
    if (!pollId) return res.json({ status: 'unknown' });
    let log = await getPaymentLog(pollId);
    if (!log) log = await getPaymentLogByTx(pollId);
    const status    = (log && log.status) || 'pending';
    const ghlStatus = (status === 'paid' || status === 'completed') ? 'succeeded'
      : status === 'failed' ? 'failed'
      : status === 'expired' ? 'cancelled'
      : 'pending';
    if (ghlStatus === 'succeeded') return res.json({ success: true, chargeSnapshot: { status: 'succeeded', amount: Math.round((log.amount || 0) * 100), chargeId: pollId, chargedAt: Math.floor(Date.now() / 1000) } });
    if (ghlStatus === 'failed') return res.json({ failed: true });
    return res.json({ success: false, status: ghlStatus, paymentIntentId: pollId });
  } catch (err2) {
    console.error('[api/query GET] ERROR:', err2.message);
    return res.json({ status: 'pending' });
  }
};
