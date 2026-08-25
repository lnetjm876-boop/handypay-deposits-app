// lib/handypay.js — HandyPay session creation (single authoritative copy)
'use strict';
const HP_BASE = 'https://api.handypay.me/api/v1';
const APP_URL = process.env.APP_URL || 'https://handypay-deposits-app.vercel.app';

async function createHandyPaySession(apiKey, amountJMD, label, metadata, passFeesToCustomer = true) {
  const preSessionId = metadata && metadata.preSessionId ? metadata.preSessionId : '';
  const r = await fetch(`${HP_BASE}/payment-sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: amountJMD,
      currency: (metadata && metadata.currency) || 'jmd',
      label,
      pass_fees_to_customer: passFeesToCustomer,
      success_url: `${APP_URL}/success?session_id=${preSessionId}`,
      cancel_url:  `${APP_URL}/cancel?session_id=${preSessionId}`,
      metadata: metadata || {}
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('hp_session ' + r.status + ': ' + JSON.stringify(d).slice(0, 80));
  const data = d.data || d;
  const id  = data.id  || data.session_id  || data.sessionId  || '';
  const url = data.url || data.checkout_url || data.checkoutUrl || '';
  if (!id) throw new Error('hp_session: no id in response: ' + JSON.stringify(data).slice(0, 100));
  return { id, url };
}

module.exports = { createHandyPaySession };
