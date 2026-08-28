// api/refund.js — GHL Custom Payment Provider refund handler
// Called by GHL when merchant requests a refund for a HandyPay payment.
// Body: { transactionId, amount, currency, locationId, reason }
// Returns: { success: true } | { success: false, error: "..." }
'use strict';

const pool = require('../lib/db');

const HP_BASE = 'https://api.handypay.me/api/v1';
const APP_URL = process.env.APP_URL || 'https://handypay-deposits-app.vercel.app';

async function fetchWithTimeout(url, opts, ms) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return r;
  } catch (e) { clearTimeout(timer); throw e; }
}

module.exports = async function handler(req, res) {
  // CORS headers — GHL calls this cross-origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST only' });

  const body = req.body || {};
  const transactionId = body.transactionId || body.chargeId || body.paymentIntentId || '';
  const locationId    = body.locationId || '';
  const rawAmount     = parseFloat(body.amount || 0) || 0;
  const reason        = body.reason || 'requested_by_customer';

  console.log('[refund] request:', JSON.stringify({ transactionId, locationId, rawAmount, reason }));

  if (!transactionId) {
    return res.status(400).json({ success: false, error: 'Missing transactionId' });
  }

  try {
    const { rows: logRows } = await pool.query(
      'SELECT * FROM payment_logs WHERE session_id=$1 OR ghl_transaction_id=$1 LIMIT 1',
      [transactionId]
    );
    const log = logRows[0] || null;

    const resolvedLocationId = (log && log.location_id) || locationId;
    if (!resolvedLocationId) {
      return res.status(400).json({ success: false, error: 'Cannot resolve location' });
    }

    const { rows: cfgRows } = await pool.query(
      'SELECT handypay_api_key FROM merchant_configs WHERE location_id=$1 LIMIT 1',
      [resolvedLocationId]
    );
    const apiKey = cfgRows[0] && cfgRows[0].handypay_api_key;
    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'HandyPay not configured for this location' });
    }

    const sessionId = log ? log.session_id : transactionId;
    const loggedAmt = log ? (log.amount || 0) : 0;
    const refundAmt = rawAmount > 0 ? Math.round(rawAmount) : loggedAmt;

    let refundId = '', refundOk = false;

    // Attempt 1: POST /refunds with session_id
    try {
      const r1 = await fetchWithTimeout(HP_BASE + '/refunds', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, amount: refundAmt, reason })
      }, 8000);
      const d1 = await r1.json().catch(() => ({}));
      console.log('[refund] attempt1 status:', r1.status, JSON.stringify(d1).substring(0, 200));
      if (r1.ok) { refundId = d1.id || d1.refund_id || ''; refundOk = true; }
    } catch (e1) { console.warn('[refund] attempt1 failed:', e1.message); }

    // Attempt 2: POST /payment-sessions/{id}/refund
    if (!refundOk) {
      try {
        const r2 = await fetchWithTimeout(HP_BASE + '/payment-sessions/' + sessionId + '/refund', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: refundAmt, reason })
        }, 8000);
        const d2 = await r2.json().catch(() => ({}));
        console.log('[refund] attempt2 status:', r2.status, JSON.stringify(d2).substring(0, 200));
        if (r2.ok) { refundId = d2.id || d2.refund_id || ''; refundOk = true; }
      } catch (e2) { console.warn('[refund] attempt2 failed:', e2.message); }
    }

    // Attempt 3: use stored payment_intent_id
    const piId = log && log.payment_intent_id;
    if (!refundOk && piId) {
      try {
        const r3 = await fetchWithTimeout(HP_BASE + '/refunds', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ payment_intent: piId, amount: refundAmt, reason })
        }, 8000);
        const d3 = await r3.json().catch(() => ({}));
        console.log('[refund] attempt3 (pi) status:', r3.status, JSON.stringify(d3).substring(0, 200));
        if (r3.ok) { refundId = d3.id || d3.refund_id || ''; refundOk = true; }
      } catch (e3) { console.warn('[refund] attempt3 failed:', e3.message); }
    }

    if (!refundOk) {
      console.error('[refund] all attempts failed for session:', sessionId);
      return res.status(400).json({
        success: false,
        error: 'Refund could not be processed automatically. Please process via HandyPay dashboard.'
      });
    }

    if (log) {
      await pool.query(
        'UPDATE payment_logs SET status=$1, updated_at=NOW() WHERE session_id=$2',
        ['refunded', sessionId]
      ).catch(e => console.warn('[refund] db update:', e.message));
    }

    console.log('[refund] success | session:', sessionId, '| refundId:', refundId);
    return res.json({ success: true, refundId, sessionId });

  } catch (e) {
    console.error('[refund] unhandled:', e.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
