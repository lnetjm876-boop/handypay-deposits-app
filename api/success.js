// api/success.js — standalone Vercel serverless function
// v2: GHL-native architecture — uses lib/ shared modules
// Handles HandyPay post-payment redirect: /success?session_id=...
//
// Flow:
//   ghl_native  → fire record-payment backup (primary = GHL /api/query polling)
//   deposit/full → updateContactFields (deposit_status=paid) → triggers Workflow 2 (tag+note+SMS)
//
// Deduplication: check existing status BEFORE markPaid so we don't double-trigger
// Workflow 2 on repeated /success redirects (user hits back, etc.)
'use strict';

const pool                    = require('../lib/db');
const { getFreshToken }       = require('../lib/token');
const { updateContactFields } = require('../lib/ghl');
const { fireRecordPayment }   = require('../lib/payments');

const GHL_API = 'https://services.leadconnectorhq.com';

// ---------- DB helpers ----------
async function getPaymentLogBySession(sessionId) {
  const { rows } = await pool.query('SELECT * FROM payment_logs WHERE session_id=$1', [sessionId]);
  return rows[0] || null;
}
async function markPaid(sessionId) {
  await pool.query('UPDATE payment_logs SET status=$1, updated_at=NOW() WHERE session_id=$2', ['paid', sessionId]);
}

// ---------- Invoice helper (ghl_native only) ----------
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

// ---------- Main handler ----------
module.exports = async function handler(req, res) {
  const sessionId = (req.query && (req.query.session_id || req.query.sessionId)) || '';

  if (sessionId) {
    try {
      // Read BEFORE marking paid → detect duplicate redirect (prevents double Workflow 2)
      const sLog       = await getPaymentLogBySession(sessionId);
      const alreadyPaid = sLog && (sLog.status === 'paid' || sLog.status === 'completed');
      await markPaid(sessionId);

      if (sLog && sLog.location_id && !alreadyPaid) {
        const tok = await getFreshToken(sLog.location_id).catch(function() { return ''; });
        if (tok) {
          const isGhlNative = sLog.payment_type === 'ghl_native';

          if (isGhlNative) {
            // INVOICE FLOW: fire record-payment as backup
            // Primary path: GHL backend polls /api/query; this is the belt-and-suspenders fallback
            let invId = (req.query && req.query.inv) || sLog.entity_id || '';
            if (!invId && sLog.ghl_transaction_id) {
              invId = await getInvoiceIdByTx(sLog.location_id, sLog.ghl_transaction_id, tok)
                .catch(function() { return ''; });
              if (invId) console.log('[success] tx->inv:', sLog.ghl_transaction_id, '->', invId);
            }
            if (invId) {
              // fire-and-forget; GHL query polling is primary
              fireRecordPayment(invId, sLog.location_id, sLog.amount, 'HandyPay:' + sessionId, tok)
                .catch(function(e) { console.error('[success] record-payment err:', e.message); });
            } else {
              console.log('[success] ghl_native: no invId for session', sessionId);
            }
          } else {
            // DEPOSIT / FULL / CALENDAR FLOW (GHL-native v2):
            // Write contact fields → triggers GHL Workflow 2 (adds tag, note, sends confirmation SMS)
            // Do NOT add tag/note directly — GHL workflow owns that logic (editable without deploys)
            if (sLog.contact_id) {
              await updateContactFields(tok, sLog.location_id, sLog.contact_id, {
                'contact.deposit_status':      'paid',
                'contact.deposit_amount_paid': String(sLog.amount || '')
              }).catch(function(e) { console.error('[success] field update err:', e.message); });
              console.log('[success] fields written → Workflow 2 fires tag+note+SMS | contact:', sLog.contact_id);
            }
          }
        }
      } else if (alreadyPaid) {
        console.log('[success] already paid, skipping GHL writes | session:', sessionId);
      }
    } catch (err) {
      console.error('[success] top-level err:', err.message);
    }
  }

  // Allow loading inside GHL iframe after location.href redirect
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Type', 'text/html');

  // postMessage to GHL iframe parent (all signal types for maximum compatibility)
  var sid = JSON.stringify(sessionId);
  var scriptContent = 'var s=' + sid + ';' +
    'if(s){try{' +
    'window.parent.postMessage(JSON.stringify({type:"custom_element_success_response",chargeId:s}),"*");' +
    'window.parent.postMessage({type:"custom_element_success_response",chargeId:s},"*");' +
    'window.parent.postMessage({type:"PAYMENT_SUCCESS",paymentIntentId:s,status:"succeeded"},"*");' +
    'window.parent.postMessage({event:"payment-success",paymentIntentId:s},"*");' +
    'if(window.opener){window.opener.postMessage({type:"PAYMENT_SUCCESS",paymentIntentId:s,status:"succeeded"},"*");setTimeout(function(){try{window.close();}catch(e){}},2000);}' +
    'window.parent.postMessage({success:true,paymentIntentId:s,orderId:s},"*");' +
    '}catch(e){}}' +
    'setTimeout(function(){try{' +
    'window.parent.postMessage(JSON.stringify({type:"custom_element_close_response"}),"*");' +
    'window.parent.postMessage({type:"custom_element_close_response"},"*");' +
    'window.parent.postMessage({type:"PAYMENT_COMPLETE",paymentIntentId:s},"*");' +
    '}catch(e){}},1500);';

  res.end('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Confirmed</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0fdf4;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;width:100%;padding:40px;text-align:center}.icon{font-size:64px;margin-bottom:16px}h1{font-size:22px;font-weight:800;color:#15803d;margin-bottom:10px}p{font-size:15px;color:#555;line-height:1.6}.sub{font-size:13px;color:#888;margin-top:20px}</style></head><body><div class="card"><div class="icon">&#x2705;</div><h1>Payment Confirmed!</h1><p>Thank you. Your payment was received successfully.</p><p class="sub">You may close this window.</p></div><script>' + scriptContent + '<\/script></body></html>');
};
