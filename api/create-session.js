// api/create-session.js
// Overrides /api/create-native-session route from server.js catch-all.
//
// Fixes vs server.js version:
//   - Accepts currency param -> live currency passed to HandyPay (no hardcoded 'jmd')
//   - Accepts paymentChoice ('deposit'|'full') -> stored as payment_type in DB
//   - Session deduplication: reuse existing pending session within 30 min
//   - Pool config: max:2, idleTimeoutMillis:10000
'use strict';

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
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
  // Whitelist supported currencies; fall back to jmd
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
    var errText = await r.text();
    throw new Error('HandyPay ' + r.status + ': ' + errText.substring(0, 120));
  }

  var d = await r.json();
  var id  = d.id || d.sessionId || d.session_id || '';
  var url = d.url || d.checkoutUrl || d.checkout_url || '';
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
  var ghlTransactionId = body.ghlTransactionId  || body.transactionId || '';
  var paymentType      = body.paymentType        || 'calendar';
  var paymentChoice    = body.paymentChoice      || 'deposit'; // 'deposit' | 'full'

  if (!locationId)      return res.status(400).json({ error: 'locationId required' });
  if (amountJMD < 80)  return res.status(400).json({ error: 'Amount too low (min J$80)' });

  try {
    var cfg = await getMerchantConfig(locationId);
    if (!cfg || !cfg.handypay_api_key) {
      return res.status(400).json({ error: 'HandyPay API key not configured. Go to Settings to add it.' });
    }

    // ── SESSION DEDUPLICATION ────────────────────────────────────────────────
    // Reuse an existing pending session for the same location + amount created
    // within the last 30 minutes. Prevents duplicate checkout sessions when the
    // GHL iframe reloads (back button, refresh, slow network).
    try {
      var existing = await pool.query(
        `SELECT session_id, checkout_url FROM payment_logs
         WHERE location_id = $1
           AND status = 'pending'
           AND amount = $2
           AND created_at > NOW() - INTERVAL '30 minutes'
         ORDER BY created_at DESC
         LIMIT 1`,
        [locationId, amountJMD]
      );
      if (existing.rows.length > 0 && existing.rows[0].checkout_url) {
        var ex = existing.rows[0];
        console.log('[create-session] reusing existing session:', ex.session_id);
        return res.json({
          paymentIntentId: ex.session_id,
          sessionId:       ex.session_id,
          checkoutUrl:     ex.checkout_url,
          reused:          true
        });
      }
    } catch (dedupErr) {
      // Non-fatal: dedup failed, fall through to create new session
      console.warn('[create-session] dedup check error (non-fatal):', dedupErr.message);
    }

    // ── CREATE HANDY PAY SESSION ─────────────────────────────────────────────
    var meta = {
      locationId,
      entityId,
      ghlTransactionId,
      paymentType,
      paymentChoice, // webhook reads this to apply correct tag
      inv: entityId || ghlTransactionId || ''
    };

    var session = await createHandyPaySession(
      cfg.handypay_api_key,
      amountJMD,
      description,
      meta,
      true,     // pass_fees_to_customer
      currency  // live currency from GHL order
    );

    // ── DETERMINE DB PAYMENT TYPE ────────────────────────────────────────────
    // Maps to the tag that will be applied on the contact after payment:
    //   'ghl_native' -> no tag (GHL handles invoice confirmation)
    //   'full'       -> 'full-payment-paid' tag
    //   'deposit'    -> 'deposit-paid' tag (default)
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
      // Non-fatal: DB insert failed but session exists — client can still pay
      console.error('[create-session] payment_logs insert failed:', logErr.message);
    }

    console.log('[create-session] ✅ session=%s amt=%s cur=%s choice=%s', session.id, amountJMD, currency, paymentChoice);

    return res.json({
      paymentIntentId: session.id,
      sessionId:       session.id,
      checkoutUrl:     session.url
    });

  } catch (e) {
    console.error('[create-session] error:', e.message);
    return res.status(500).json({ error: e.message || 'Failed to create payment session' });
  }
};
