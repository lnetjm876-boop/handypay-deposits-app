// api/webhook-hp.js — HandyPay payment webhook handler (GHL-native architecture v2)
//
// REMOVED: addContactTag, addContactNote, lookupContactId
// ADDED:   updateContactFields — writes deposit_status + deposit_amount_paid to contact
// GHL Workflow 'Deposit Confirmed' handles: tag + note + SMS + follow-up
//
'use strict';

const crypto = require('crypto');
const pool   = require('../lib/db');
const { getFreshToken }                      = require('../lib/token');
const { updateContactFields, addContactTag } = require('../lib/ghl');
const { fireRecordPayment }                  = require('../lib/payments');

const GHL_API = 'https://services.leadconnectorhq.com';
const V = '2021-07-28';

async function getMerchantConfig(locationId) {
  const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [locationId]);
  return rows[0] || null;
}
async function getPaymentLog(sessionId) {
  const { rows } = await pool.query('SELECT * FROM payment_logs WHERE session_id=$1', [sessionId]);
  return rows[0] || null;
}
async function markLogPaid(sessionId) {
  await pool.query('UPDATE payment_logs SET status=$1, updated_at=NOW() WHERE session_id=$2', ['paid', sessionId]);
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return true;
  try {
    const parts  = sigHeader.split(',');
    const tPart  = parts.find(p => p.startsWith('t='));
    const v1Part = parts.find(p => p.startsWith('v1='));
    if (!tPart || !v1Part) return true;
    const payload  = tPart.substring(2) + '.' + rawBody;
    const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1Part.substring(3), 'hex'));
  } catch (e) { console.warn('[webhook-hp] sig verify error:', e.message); return true; }
}

const handler = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let rawBuf;
  try { rawBuf = await getRawBody(req); }
  catch (e) { return res.status(400).json({ error: 'body read failed' }); }
  const rawBody = rawBuf.toString('utf8');

  let obj;
  try { obj = JSON.parse(rawBody); }
  catch (e) { return res.status(400).json({ ok: false, error: 'invalid JSON' }); }

  const type       = obj.type || obj.event || '';
  const dataObj    = obj.data || {};
  const sessionId  = dataObj.id || (dataObj.object && dataObj.object.id) || obj.id || '';
  const meta       = dataObj.metadata || (dataObj.object && dataObj.object.metadata) || obj.metadata || {};
  const locationId = meta.locationId || '';

  console.log('[webhook-hp] type:', type, 'session:', sessionId, 'loc:', locationId);

  if (locationId) {
    try {
      const cfg    = await getMerchantConfig(locationId);
      const secret = cfg && cfg.handypay_webhook_secret;
      const sig    = req.headers['stripe-signature'] || req.headers['x-handypay-signature'] || '';
      if (secret && sig && !verifySignature(rawBody, sig, secret)) {
        console.error('[webhook-hp] signature mismatch for:', locationId);
        return res.status(400).json({ ok: false, error: 'invalid_signature' });
      }
    } catch (e) { console.warn('[webhook-hp] sig check (non-fatal):', e.message); }
  }

  const isPaid = ['payment.succeeded','checkout.session.completed','payment_intent.succeeded'].includes(type);
  const isExpired = type === 'checkout.session.expired';
  if (!isPaid && !isExpired) return res.json({ ok: true, skipped: type });

  // Idempotency
  const existingLog = sessionId ? await getPaymentLog(sessionId).catch(() => null) : null;
  if (existingLog && existingLog.status === 'paid') {
    console.log('[webhook-hp] already processed:', sessionId);
    return res.json({ ok: true, skipped: 'already_paid' });
  }
  if (sessionId) await markLogPaid(sessionId).catch(e => console.error('[webhook-hp] mark paid:', e.message));

  const log       = existingLog || (sessionId ? await getPaymentLog(sessionId).catch(() => null) : null);
  const locId     = locationId || (log && log.location_id) || '';
  const contactId = meta.contactId || (log && log.contact_id) || '';
  const payType   = meta.paymentType || (log && log.payment_type) || 'deposit';
  const amount    = (dataObj.amount_total || (dataObj.object && dataObj.object.amount_total))
    ? Math.round((dataObj.amount_total || dataObj.object.amount_total) / 100)
    : (log && log.amount) || 0;

  // Expired session → write deposit_status=expired → triggers W4 (Link Expired) workflow
  if (isExpired) {
    const expLocId  = locationId || (existingLog && existingLog.location_id) || '';
    const expContId = meta.contactId || (existingLog && existingLog.contact_id) || '';
    if (expLocId && expContId) {
      try {
        const expTok = await getFreshToken(expLocId);
        await updateContactFields(expTok, expLocId, expContId, { 'contact.deposit_status': 'expired' });
        console.log('[webhook-hp] ✅ deposit_status=expired written | contact:', expContId);
      } catch(e) { console.error('[webhook-hp] expired field write:', e.message); }
    }
    return res.json({ ok: true, mode: 'expired' });
  }

  // ghl_native: invoice payment — record it, then done
  if (payType === 'ghl_native') {
    if (locId) {
      try {
        const tok   = await getFreshToken(locId);
        const invId = meta.entityId || (log && (log.entity_id || log.appointment_id)) || '';
        if (invId && tok) await fireRecordPayment(invId, locId, amount, 'HandyPay-webhook:' + sessionId, tok);
      } catch (e) { console.error('[webhook-hp] ghl_native record-payment:', e.message); }
    }
    return res.json({ ok: true, mode: 'ghl_native' });
  }

  // Deposit / full payment — update contact fields → GHL workflow takes over
  if (!locId) return res.json({ ok: true, note: 'no_location' });

  let token;
  try { token = await getFreshToken(locId); }
  catch (e) {
    console.error('[webhook-hp] no token for:', locId, e.message);
    return res.json({ ok: true, note: 'no_token' });
  }

  if (!contactId) {
    console.warn('[webhook-hp] no contactId for session:', sessionId);
    return res.json({ ok: true, note: 'no_contact' });
  }

  // Write deposit_status + deposit_amount_paid → GHL Workflow fires from here
  try {
    await updateContactFields(token, locId, contactId, {
      'contact.deposit_status':      'paid',
      'contact.deposit_amount_paid': String(amount)
    });
    console.log('[webhook-hp] ✅ fields updated | contact:', contactId, '| JMD', amount);
  } catch (e) { console.error('[webhook-hp] updateContactFields:', e.message); }

  // Confirm appointment in calendar (non-blocking)
  const apptId = meta.appointmentId || (log && log.appointment_id) || '';
  if (apptId && apptId.length > 10) {
    fetch(`${GHL_API}/calendars/events/appointments/${apptId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Version: V },
      body: JSON.stringify({ appointmentStatus: 'confirmed' })
    }).catch(e => console.warn('[webhook-hp] appt confirm:', e.message));
  }

  return res.json({ ok: true, mode: payType, amount, contactId });
};

handler.config = { api: { bodyParser: false } };
module.exports = handler;
