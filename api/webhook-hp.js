// api/webhook-hp.js
// Overrides /api/webhooks/handypay route from server.js catch-all.
//
// Fixes vs server.js version:
//   - IDEMPOTENCY: skips if session already status='paid'
//   - CORRECT TAGGING: 'deposit-paid' OR 'full-payment-paid' based on paymentChoice
//   - AWAIT tag+note before responding (prevents Vercel fire-and-forget kill)
//   - CONFIG FIX: handler.config attached after defining handler
//   - CONTACT LOOKUP: if contactId not in metadata, fetches GHL order by entityId
//     to resolve the contactId dynamically (fixes no_contact on all calendar bookings)
//   - Pool config: max:3
'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000
});

const GHL_API = 'https://services.leadconnectorhq.com';

// ── Helpers ──────────────────────────────────────────────────────────────────────
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    var chunks = [];
    req.on('data', function(chunk) { chunks.push(chunk); });
    req.on('end',  function()      { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

async function getMerchantConfig(locationId) {
  const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [locationId]);
  return rows[0] || null;
}

async function getPaymentLogBySession(sessionId) {
  const { rows } = await pool.query('SELECT * FROM payment_logs WHERE session_id=$1', [sessionId]);
  return rows[0] || null;
}

async function updatePaymentLogStatus(sessionId, status) {
  await pool.query('UPDATE payment_logs SET status=$1, updated_at=NOW() WHERE session_id=$2', [status, sessionId]);
}

async function getFreshToken(locationId) {
  var cfg = await getMerchantConfig(locationId).catch(function(){return null;});
  if (!cfg) return '';
  return cfg.crm_access_token || cfg.ghl_access_token || '';
}

async function addContactTag(accessToken, contactId, tags) {
  var r = await fetch(GHL_API + '/contacts/' + contactId + '/tags', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
    body: JSON.stringify({ tags: tags })
  });
  if (!r.ok) console.error('[webhook-hp] tag failed:', r.status);
  return r.json().catch(function(){});
}

async function addContactNote(accessToken, contactId, body) {
  var r = await fetch(GHL_API + '/contacts/' + contactId + '/notes', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
    body: JSON.stringify({ body: body })
  });
  if (!r.ok) console.error('[webhook-hp] note failed:', r.status);
  return r.json().catch(function(){});
}

// ── Look up contactId from a GHL order ────────────────────────────────────────
async function lookupContactId(accessToken, orderId) {
  if (!accessToken || !orderId) return '';
  try {
    var r = await fetch(GHL_API + '/payments/orders/' + orderId, {
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Version': '2021-07-28' }
    });
    if (!r.ok) {
      console.warn('[webhook-hp] order lookup', r.status, 'for orderId:', orderId);
      return '';
    }
    var d = await r.json();
    // GHL order has contactId at top level or nested under contact object
    var cid = d.contactId || d.contact_id
      || (d.contact && (d.contact.id || d.contact._id))
      || '';
    console.log('[webhook-hp] order lookup contactId:', cid || 'not_found', 'orderId:', orderId);
    return cid;
  } catch(e) {
    console.warn('[webhook-hp] order lookup error:', e.message);
    return '';
  }
}

// ── Signature verification (Stripe-style HMAC-SHA256) ──────────────────────────
function verifySignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return true;
  try {
    var parts     = sigHeader.split(',');
    var tPart     = parts.find(function(p){ return p.startsWith('t='); });
    var v1Part    = parts.find(function(p){ return p.startsWith('v1='); });
    if (!tPart || !v1Part) return true;
    var timestamp = tPart.substring(2);
    var signature = v1Part.substring(3);
    var payload   = timestamp + '.' + rawBody;
    var expected  = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch(e) {
    console.warn('[webhook-hp] signature verify error:', e.message);
    return true;
  }
}

// ── Handler ────────────────────────────────────────────────────────────────────────────
const handler = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Read raw body for HMAC signature verification
  var rawBuf;
  try { rawBuf = await getRawBody(req); }
  catch(e) { return res.status(400).json({ error: 'Failed to read body' }); }
  var rawBody = rawBuf.toString('utf8');

  var obj;
  try { obj = JSON.parse(rawBody); }
  catch(e) { return res.status(400).json({ ok: false, error: 'invalid JSON' }); }

  var type       = obj.type || obj.event || '';
  var dataObj    = obj.data || {};
  var sessionId  = (dataObj.id || dataObj.sessionId || (dataObj.object && dataObj.object.id)) || obj.sessionId || obj.id || '';
  var meta       = (dataObj.metadata || (dataObj.object && dataObj.object.metadata)) || obj.metadata || {};
  var locationId = meta.locationId || '';

  console.log('[webhook-hp] type:', type, 'session:', sessionId, 'location:', locationId);

  // Verify signature
  if (locationId) {
    try {
      var cfg = await getMerchantConfig(locationId);
      var secret = cfg && cfg.handypay_webhook_secret;
      var sigHeader = req.headers['stripe-signature'] || req.headers['x-handypay-signature'] || '';
      if (secret && sigHeader && !verifySignature(rawBody, sigHeader, secret)) {
        console.error('[webhook-hp] signature mismatch for location:', locationId);
        return res.status(400).json({ ok: false, error: 'invalid signature' });
      }
    } catch(e) {
      console.warn('[webhook-hp] config fetch for sig check failed:', e.message);
    }
  }

  var isPaid = ['payment.succeeded','checkout.session.completed','payment_intent.succeeded'].indexOf(type) !== -1;
  if (!isPaid) return res.json({ ok: true, skipped: type });

  // ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
if (sessionId) {
    try {
      var existingLog = await getPaymentLogBySession(sessionId);
      if (existingLog && existingLog.status === 'paid') {
        console.log('[webhook-hp] already processed, skipping:', sessionId);
        return res.json({ ok: true, skipped: 'already_paid' });
      }
    } catch(iErr) {
      console.warn('[webhook-hp] idempotency check error (non-fatal):', iErr.message);
    }
  }

  if (sessionId) {
    try { await updatePaymentLogStatus(sessionId, 'paid'); }
    catch(e) { console.error('[webhook-hp] status update error:', e.message); }
  }

  var log        = sessionId ? (await getPaymentLogBySession(sessionId).catch(function(){return null;})) : null;
  var contactId  = meta.contactId || (log && log.contact_id) || '';
  if (!locationId) locationId = (log && log.location_id) || '';
  var amount     = (dataObj.amount_total || (dataObj.object && dataObj.object.amount_total))
    ? Math.round(((dataObj.amount_total || dataObj.object.amount_total) || 0) / 100)
    : (log && log.amount) || 0;
  var currency   = (log && log.currency ? log.currency.toUpperCase() : 'JMD');
  var payChoice  = meta.paymentChoice || (log && log.payment_type) || 'deposit';
  var payType    = meta.paymentType   || (log && log.payment_type) || 'deposit';

  if (payType === 'ghl_native') {
    console.log('[webhook-hp] ghl_native — skipping contact tag/note');
    return res.json({ ok: true, mode: 'ghl_native' });
  }

  if (!locationId) return res.json({ ok: true, note: 'no_location' });

  // Fetch token once — used for both order lookup + tagging
  var accessToken = await getFreshToken(locationId).catch(function(){return '';});
  if (!accessToken) {
    console.error('[webhook-hp] no CRM token for:', locationId);
    return res.json({ ok: true, note: 'no_token' });
  }

  // ── CONTACT LOOKUP ─────────────────────────────────────────────────────────────
  // contactId is NOT in HandyPay metadata (never included at session-creation time).
  // Fall back to fetching the GHL order by entityId to resolve it dynamically.
  // This covers 100% of calendar booking payments.
  if (!contactId) {
    var orderId = meta.entityId || meta.ghlTransactionId || (log && log.ghl_transaction_id) || '';
    if (orderId) {
      contactId = await lookupContactId(accessToken, orderId);
    }
  }

  if (!contactId) {
    console.log('[webhook-hp] contactId not found after order lookup — skipping tag/note');
    return res.json({ ok: true, note: 'no_contact' });
  }

  // ── TAGGING ──────────────────────────────────────────────────────────────────────
var tag, noteText;
  if (payChoice === 'full') {
    tag      = 'full-payment-paid';
    noteText = 'Full payment received via HandyPay: ' + amount + ' ' + currency;
  } else {
    tag      = 'deposit-paid';
    noteText = 'Deposit received via HandyPay: ' + amount + ' ' + currency;
  }

  try {
    await Promise.all([
      addContactTag(accessToken, contactId, [tag]),
      addContactNote(accessToken, contactId, noteText)
    ]);
    console.log('[webhook-hp] ✅ tagged:', tag, 'contact:', contactId, 'amount:', amount, currency);
  } catch(e) {
    console.error('[webhook-hp] tag/note error:', e.message);
  }

  return res.json({ ok: true, tag, amount, currency, payChoice, contactId });
};

// Config MUST be attached to handler after definition.
// Setting module.exports.config before module.exports = handler wipes the config.
handler.config = { api: { bodyParser: false } };
module.exports = handler;
