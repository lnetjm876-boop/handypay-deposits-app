// lib/handypay.js — HandyPay API client shared across all functions
'use strict';
const HP_BASE = 'https://api.handypay.me/api/v1';

// Create a HandyPay payment session
// Returns { id, url }
async function createHandyPaySession(apiKey, amountJMD, label, meta, passFeesToCustomer) {
  const payload = {
    amount:                amountJMD,
    currency:              'jmd',
    description:           label || 'Deposit',
    pass_fees_to_customer: passFeesToCustomer !== false,
    metadata:              meta || {}
  };
  const r = await fetch(HP_BASE + '/sessions', {
    method:  'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload)
  });
  if (!r.ok) {
    const t = await r.text().catch(function() { return ''; });
    throw new Error('HandyPay session ' + r.status + ': ' + t.slice(0, 200));
  }
  const d = await r.json();
  const id  = (d.data && d.data.id)  || d.id  || d.session_id;
  const url = (d.data && d.data.url) || d.url || d.checkout_url;
  if (!id) throw new Error('HandyPay: no session id in response');
  return { id: id, url: url };
}

module.exports = { createHandyPaySession };
