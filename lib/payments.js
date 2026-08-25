// lib/payments.js — GHL invoice record-payment (single authoritative copy)
'use strict';
const GHL_API = 'https://services.leadconnectorhq.com';
const V = '2021-07-28';

async function fireRecordPayment(invoiceId, locationId, amount, note, token) {
  const r = await fetch(`${GHL_API}/invoices/${invoiceId}/record-payment`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Version: V },
    body: JSON.stringify({ locationId, amount, note: note || 'HandyPay payment', paymentMode: 'cash', isNotified: false })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('record-payment ' + r.status + ': ' + JSON.stringify(d).slice(0, 80));
  return d;
}

module.exports = { fireRecordPayment };
