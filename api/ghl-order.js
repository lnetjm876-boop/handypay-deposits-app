// api/ghl-order.js — proxy GHL public order endpoint
// Called by api/pay.js iframe when it has an orderId but no amount.
// GHL's public order endpoint is unauthenticated — safe to proxy.
'use strict';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const orderId = (req.query && req.query.orderId) || '';
  if (!orderId || orderId.length < 10) return res.status(400).json({ error: 'orderId required' });

  try {
    const r = await fetch('https://backend.leadconnectorhq.com/payments/orders/public/' + encodeURIComponent(orderId));
    if (!r.ok) {
      console.error('[ghl-order] GHL returned', r.status);
      return res.json({ error: 'GHL order not found', status: r.status, amount: 0 });
    }
    const d = await r.json();
    // initialAmount = deposit (partial payment), fallback to full amount
    const payAmt = (d.paymentSummary && d.paymentSummary.initialAmount > 0)
      ? d.paymentSummary.initialAmount
      : (d.amount || 0);
    const currency = d.currency || 'JMD';
    const description = (d.source && d.source.name) ||
      (d.items && d.items[0] && d.items[0].product && d.items[0].product.name) ||
      'Booking Deposit';
    const transactionId = d._id || orderId;
    const appointmentId = d.source && d.source.appointmentId || '';
    console.log('[ghl-order]', orderId, 'amt:', payAmt, currency);
    return res.json({
      orderId: d._id || orderId,
      amount: payAmt,
      currency,
      description,
      transactionId,
      appointmentId,
      isPartial: !!(d.paymentSummary && d.paymentSummary.isPartialPayment)
    });
  } catch (e) {
    console.error('[ghl-order] error:', e.message);
    return res.json({ error: e.message, amount: 0 });
  }
};
