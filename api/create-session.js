// api/create-session.js
// Overrides /api/create-native-session route from server.js catch-all.
//
// Fixes vs server.js version:
//   - Accepts currency param -> live currency passed to HandyPay (no hardcoded 'jmd')
//   - Accepts paymentChoice ('deposit'|'full') -> stored as payment_type in DB
//   - Session deduplication: by ghl_transaction_id (order ID) first, fall back to amount
//     Prevents two customers paying the same service price from sharing a session
//   - Pool config: max:3, idleTimeoutMillis:10000
//   - Unwrap HandyPay .data envelope: response is {success,data:{id,url}} not {id,url}
//   - Friendly error for HandyPay 'too many sessions' rate limit
'use strict';

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000
});

const HP_BASE = 'https://api.handypay.me/api/v1';
const APP_URL = process.env.APP_URL || 'https://handypay-deposits-app.vercel.app';

async function getMerchantConfig(locationId) {
  const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [locationId]);
  return rows[0] || null;
}

async function createHandyPaySession(apiKey, amountJMD, label, meta, passFeesToCustomer, currency) {
  var cur = (currency || 'jmd').toLowerCase();
  if (!['jmd','usd','ttd','bbd','bsd','gyd','kyd'].includes(cur)) cur = 'jmd';

  var payload = {
    line_items: [{ amount: Math.round(amountJMD) * 100, currency: cur, name: label, quantity: 1 }],
    mode: 'payment',
    success_url: APP_URL + '/success?session_id={CHECKOUT_SESSION_ID}'
      + (meta && meta.inv ? '&inv=' + encodeURIComponent(meta.inv) : ''),
    cancel_url: APP_URL + '/cancel',
    pass_fees_to_customer: passFeesToCustomer !== false,
    metadata: meta || {}
  };

  var r = await fetch(HP_BASE + '/payment-sessions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    var errBody = {};
    try { errBody = await r.json(); } catch(e) {}
    var errMsg = JSON.stringify(errBody).toLowerCase();

    if (r.status === 429 || errMsg.includes('too many') || errMsg.includes('session limit')) {
      throw new Error('too_many_sessions: An open payment session already exists. Please wait a few minutes and try again.');
    }

    throw new Error('HandyPay ' + r.status + ': ' + JSON.stringify(errBody).substring(0, 120));
  }

  var d = await r.json();
  // HandyPay wraps session in { success: true, data: { id, url } }
  var obj = d.data || d;
  var id  = obj.id || obj.sessionId || obj.session_id || '';
  var url = obj.url || obj.checkoutUrl || obj.checkout_url || '';
  if (!id || !url) throw new Error('HandyPay returned empty id/url: ' + JSON.stringify(d).substring(0,120));
  return { id, url };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  res.setHeader('X-Frame-Options', 'ALLOWALL');

  var body = req.body || {};
  var locationId       = body.locationId       || '';
  var amountJMD        = parseFloat(body.amountJMD || body.amount || 0);
  var currency         = (body.currency         || 'JMD').toUpperCase();
  var description      = body.description       || 'HandyPay Payment';
  var entityId         = body.entityId          || body.orderId || '';
  var ghlTransactionId = body.ghlTransactionId  || body.transactionId || entityId || '';
  var paymentType      = body.paymentType        || 'calendar';
  var paymentChoice    = body.paymentChoice      || 'deposit';

  if (!locationId)      return res.status(400).json({ error: 'locationId required' });
  if (amountJMD < 80)  return res.status(400).json({ error: 'Amount too low (min J$80)' });

  try {
    var cfg = await getMerchantConfig(locationId);
    if (!cfg || !cfg.handypay_api_key) {
      return res.status(400).json({ error: 'HandyPay API key not configured. Go to Settings to add it.' });
    }

    // ── SESSION DEDUPLICATION ────────────────────────────────────────────────
    // Priority 1: dedup by GHL order/transaction ID (unique per booking).
    //   Prevents the same booking from creating multiple HandyPay sessions
    //   on retries, even across different amounts.
    // Priority 2: dedup by amount (fallback when no order ID is available,
    //   e.g. invoice flow). Two different customers with the same service
    //   price could theoretically collide, but only within 2 hours.
    try {
      var dedupRow = null;

      if (ghlTransactionId) {
        var r1 = await pool.query(
          `SELECT session_id, checkout_url FROM payment_logs
           WHERE location_id = $1
             AND status = 'pending'
             AND ghl_transaction_id = $2
             AND created_at > NOW() - INTERVAL '2 hours'
           ORDER BY created_at DESC LIMIT 1`,
          [locationId, ghlTransactionId]
        );
        dedupRow = r1.rows[0] || null;
      }

      if (!dedupRow) {
        var r2 = await pool.query(
          `SELECT session_id, checkout_url FROM payment_logs
           WHERE location_id = $1
             AND status = 'pending'
             AND amount = $2
             AND created_at > NOW() - INTERVAL '2 hours'
           ORDER BY created_at DESC LIMIT 1`,
          [locationId, amountJMD]
        );
        dedupRow = r2.rows[0] || null;
      }

      if (dedupRow && dedupRow.checkout_url) {
        console.log('[create-session] reusing existing session:', dedupRow.session_id);
        return res.json({
          paymentIntentId: dedupRow.session_id,
          sessionId:       dedupRow.session_id,
          checkoutUrl:     dedupRow.checkout_url,
          reused:          true
        });
      }
    } catch (dedupErr) {
      console.warn('[create-session] dedup check error (non-fatal):', dedupErr.message);
    }

    // ── CREATE HANDY PAY SESSION ─────────────────────────────────────────────
    var meta = {
      locationId,
      entityId,
      ghlTransactionId,
      paymentType,
      paymentChoice,
      inv: entityId || ghlTransactionId || ''
    };

    var session = await createHandyPaySession(
      cfg.handypay_api_key,
      amountJMD,
      description,
      meta,
      true,
      currency
    );

    var dbPaymentType = paymentType === 'ghl_native' ? 'ghl_native'
      : paymentChoice === 'full' ? 'full'
      : 'deposit';

    // ── STORE IN PAYMENT LOGS ────────────────────────────────────────────────
    try {
      await pool.query(
        `INSERT INTO payment_logs
           (session_id, location_id, amount, currency, status, payment_type, checkout_url, ghl_transaction_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, NOW(), NOW())
         ON CONFLICT (session_id) DO NOTHING`,
        [
          session.id,
          locationId,
          amountJMD,
          currency.toLowerCase(),
          dbPaymentType,
          session.url,
          ghlTransactionId || ''
        ]
      );
    } catch (logErr) {
      console.error('[create-session] payment_logs insert failed:', logErr.message);
    }

    console.log('[create-session] ✅ session=%s amt=%s cur=%s choice=%s txn=%s',
      session.id, amountJMD, currency, paymentChoice, ghlTransactionId);

    return res.json({
      paymentIntentId: session.id,
      sessionId:       session.id,
      checkoutUrl:     session.url
    });

  } catch (e) {
    console.error('[create-session] error:', e.message);
    var userMsg = e.message && e.message.startsWith('too_many_sessions:')
      ? 'An open payment session already exists. Please wait a few minutes and try again.'
      : (e.message || 'Failed to create payment session');
    return res.status(500).json({ error: userMsg });
  }
};
