// api/webhook-hp.js — HandyPay payment webhook handler v3
// ARCHITECTURE SHIFT: app no longer adds tags/notes directly.
// After confirming payment the app writes to 2 contact custom fields:
//   deposit_status      → "paid"   (triggers GHL Workflow "Deposit Confirmed")
//   deposit_amount_paid → amount   (used in GHL workflow note text)
// GHL Workflow handles: add tag, add note, send confirmation SMS, start upsell sequence.
// This keeps all CRM communication logic in GHL where it can be edited without deploys.
'use strict';
const { Pool } = require('pg');

const GHL_API   = 'https://services.leadconnectorhq.com';
const HP_BASE   = 'https://api.handypay.me/api/v1';
const APP_URL   = process.env.APP_URL || 'https://handypay-deposits-app.vercel.app';

// Custom field IDs (created 2026-08-25)
const CF_DEPOSIT_STATUS = 'U5ZFR70chqhsm17CGyTZ';  // contact.deposit_status
const CF_DEPOSIT_AMOUNT = 'SbbZbk7h0jF4p02SLssW';  // contact.deposit_amount_paid

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000
});

// ── DB helpers ──────────────────────────────────────────────
async function getConfig(locationId) {
  const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [locationId]);
  return rows[0] || null;
}

async function getLogBySession(sessionId) {
  const { rows } = await pool.query('SELECT * FROM payment_logs WHERE session_id=$1', [sessionId]);
  return rows[0] || null;
}

// ── Token (PIT-first) ───────────────────────────────────────────────
async function getFreshToken(locationId) {
  const { rows } = await pool.query(
    'SELECT crm_access_token, crm_refresh_token FROM merchant_configs WHERE location_id=$1',
    [locationId]
  );
  if (!rows[0]) throw new Error('no_config');
  const cfg = rows[0];
  if (!cfg.crm_refresh_token) return cfg.crm_access_token || '';   // PIT — never expires
  // OAuth refresh
  const r = await fetch(GHL_API + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id:     process.env.GHL_CLIENT_ID,
      client_secret: process.env.GHL_CLIENT_SECRET,
      refresh_token: cfg.crm_refresh_token
    })
  });
  if (!r.ok) throw new Error('token_refresh_failed:' + r.status);
  const d = await r.json();
  await pool.query('UPDATE merchant_configs SET crm_access_token=$1,crm_refresh_token=$2,updated_at=NOW() WHERE location_id=$3',
    [d.access_token, d.refresh_token, locationId]);
  return d.access_token;
}

// ── GHL: update contact custom fields ──────────────────────────────────
// Writes deposit_status + deposit_amount_paid → triggers GHL workflow
async function updateContactFields(accessToken, contactId, fields) {
  const customFields = Object.entries(fields).map(function([id, val]) {
    return { id: id, value: String(val) };
  });
  const r = await fetch(GHL_API + '/contacts/' + contactId, {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
    body: JSON.stringify({ customFields: customFields })
  });
  if (!r.ok) {
    const t = await r.text().catch(function() { return ''; });
    console.error('[updateContactFields]', r.status, t.slice(0, 200));
  }
  return r.json().catch(function() {});
}

// ── GHL: look up contactId from GHL order (fallback for native sessions) ──────
async function lookupContactId(accessToken, orderId, locationId) {
  try {
    const r = await fetch(GHL_API + '/payments/orders/' + orderId + '?altId=' + locationId + '&altType=location', {
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Version': '2021-07-28' }
    });
    if (!r.ok) return null;
    const d = await r.json();
    return (d.contactSnapshot && d.contactSnapshot.id) || (d.contact && d.contact.id) || null;
  } catch(e) {
    console.error('[lookupContactId]', e.message);
    return null;
  }
}

// ── GHL: mark GHL invoice as paid ────────────────────────────────────
async function fireRecordPayment(invoiceId, locationId, amount, note, token) {
  const r = await fetch(GHL_API + '/invoices/' + invoiceId + '/record-payment', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
    body: JSON.stringify({ locationId: locationId, amountDue: amount, notes: note || 'Paid via HandyPay' })
  });
  if (!r.ok) {
    const t = await r.text().catch(function() { return ''; });
    throw new Error('record-payment ' + r.status + ': ' + t.slice(0, 200));
  }
  return r.json();
}

// ── Webhook signature verification ───────────────────────────────────────
function verifySignature(secret, rawBody, sigHeader) {
  if (!secret || !sigHeader) return true; // skip if not configured
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return sigHeader === expected || sigHeader === 'sha256=' + expected;
}

// ── MAIN HANDLER ──────────────────────────────────────────────
async function handler(req, res) {
  // Collect raw body for signature verification
  let rawBody = '';
  if (typeof req.body === 'string') {
    rawBody = req.body;
  } else if (Buffer.isBuffer(req.body)) {
    rawBody = req.body.toString('utf8');
  } else {
    rawBody = JSON.stringify(req.body || {});
  }

  let event;
  try { event = JSON.parse(rawBody); } catch(e) { return res.status(400).json({ error: 'invalid_json' }); }

  const sessionId = (event.data && event.data.id) || event.id || event.session_id;
  const eventType = event.type || event.event;

  console.log('[HP Webhook]', eventType, sessionId);

  // ── Look up payment log ──
  const sLog = sessionId ? await getLogBySession(sessionId) : null;
  if (!sLog) {
    console.warn('[HP Webhook] no payment_log for session', sessionId);
    return res.json({ ok: false, error: 'session_not_found' });
  }

  const locationId = sLog.location_id;

  // ── Signature check (per-account secret stored in merchant_configs) ──
  const cfg = await getConfig(locationId);
  if (cfg && cfg.handypay_webhook_secret) {
    const sig = req.headers['x-handypay-signature'] || req.headers['x-hp-signature'] || '';
    if (!verifySignature(cfg.handypay_webhook_secret, rawBody, sig)) {
      console.error('[HP Webhook] signature mismatch for', locationId);
      return res.status(401).json({ error: 'invalid_signature' });
    }
  }

  // ── Handle checkout.session.expired ──
  if (eventType === 'checkout.session.expired') {
    await pool.query("UPDATE payment_logs SET status='expired', updated_at=NOW() WHERE session_id=$1", [sessionId])
      .catch(function(e) { console.error('[DB expire]', e.message); });
    return res.json({ ok: true, action: 'expired' });
  }

  // ── Handle checkout.session.completed ──
  if (eventType !== 'checkout.session.completed') {
    return res.json({ ok: true, action: 'ignored', type: eventType });
  }

  // ── Idempotency: skip if already processed ──
  if (sLog.status === 'paid' && sLog.record_payment_done) {
    console.log('[HP Webhook] already processed, skipping', sessionId);
    return res.json({ ok: true, action: 'already_processed' });
  }

  // ── Get token ──
  let accessToken = '';
  try { accessToken = await getFreshToken(locationId); }
  catch(e) { console.error('[token]', e.message); }

  const amount    = sLog.amount;
  const contactId = sLog.contact_id;
  const payType   = sLog.payment_type || 'deposit';
  const entityId  = sLog.entity_id || sLog.ghl_transaction_id || '';

  // ── Mark paid in DB ──
  await pool.query(
    "UPDATE payment_logs SET status='paid', updated_at=NOW() WHERE session_id=$1",
    [sessionId]
  ).catch(function(e) { console.error('[DB paid]', e.message); });

  // ── GHL native: mark invoice paid ──
  if (payType === 'ghl_native' && entityId && accessToken) {
    try {
      const txRes = await pool.query('SELECT ghl_transaction_id FROM payment_logs WHERE session_id=$1', [sessionId]);
      const txId  = txRes.rows[0] && txRes.rows[0].ghl_transaction_id;
      if (txId) {
        await fireRecordPayment(txId, locationId, amount, 'Paid via HandyPay: ' + sessionId, accessToken);
        await pool.query("UPDATE payment_logs SET record_payment_done=TRUE WHERE session_id=$1", [sessionId]);
        console.log('[HP Webhook] invoice marked paid:', txId);
      }
    } catch(e) {
      console.error('[record-payment]', e.message);
    }
  }

  // ── Resolve contactId (fallback for native sessions) ──
  let resolvedContactId = contactId;
  if (!resolvedContactId && entityId && accessToken) {
    resolvedContactId = await lookupContactId(accessToken, entityId, locationId);
    if (resolvedContactId) {
      await pool.query('UPDATE payment_logs SET contact_id=$1 WHERE session_id=$2', [resolvedContactId, sessionId])
        .catch(function() {});
    }
  }

  // ── GHL NATIVE: write to contact fields → triggers GHL Workflow "Deposit Confirmed"
  // GHL Workflow handles: add tag deposit-paid, add note, send confirmation SMS, start upsell
  if (resolvedContactId && accessToken) {
    try {
      await updateContactFields(accessToken, resolvedContactId, {
        [CF_DEPOSIT_STATUS]: 'paid',
        [CF_DEPOSIT_AMOUNT]: amount
      });
      console.log('[HP Webhook] contact fields updated → GHL workflow triggered for', resolvedContactId);
    } catch(e) {
      console.error('[updateContactFields]', e.message);
    }
  } else {
    console.warn('[HP Webhook] no contactId to update fields for session', sessionId);
  }

  res.json({
    ok:          true,
    action:      'processed',
    sessionId:   sessionId,
    contactId:   resolvedContactId,
    amount:      amount,
    paymentType: payType
  });
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
