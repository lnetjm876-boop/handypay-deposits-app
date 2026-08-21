// api/balance.js — Remaining Balance Collection Page
//
// Supports two URL patterns:
//   GET /api/balance?locationId=XXX&orderId=YYY        (direct order link)
//   GET /api/balance?locationId=XXX&contactId=ZZZ      (GHL workflow-friendly)
//
// When contactId is supplied, the server fetches the most recent
// partially-paid calendar order for that contact using the location’s CRM token.
// This lets GHL Appointment Reminder workflows use:
//   {{location.id}} and {{contact.id}} as merge fields — no custom fields needed.
//
// Flow:
//   1. Resolve GHL order → total amount + service name
//   2. Sum deposits already paid in payment_logs by ghl_transaction_id
//   3. Remaining = total − paid
//   4. Show “Pay Remaining Balance” button → HandyPay checkout
//   5. Webhook fires → tags contact full-payment-paid
'use strict';

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000
});

const GHL_API = 'https://services.leadconnectorhq.com';
const APP_URL = process.env.APP_URL || 'https://handypay-deposits-app.vercel.app';

async function fetchWithTimeout(url, opts, ms) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return r;
  } catch(e) { clearTimeout(timer); throw e; }
}

async function getMerchantConfig(locationId) {
  const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [locationId]);
  return rows[0] || null;
}

async function getPaidDeposit(locationId, orderId) {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS paid
       FROM payment_logs
       WHERE location_id = $1
         AND ghl_transaction_id = $2
         AND status = 'paid'
         AND payment_type != 'ghl_native'`,
      [locationId, orderId]
    );
    return parseFloat(rows[0]?.paid || 0);
  } catch(e) {
    console.error('[balance] getPaidDeposit error:', e.message);
    return 0;
  }
}

// Fetch GHL order via public (no auth) endpoint
async function fetchPublicOrder(orderId) {
  try {
    const r = await fetchWithTimeout(
      'https://backend.leadconnectorhq.com/payments/orders/public/' + orderId, {}, 3000
    );
    if (!r.ok) return null;
    return await r.json();
  } catch(e) { return null; }
}

// Fetch most recent partially-paid calendar order for a contact (requires CRM token)
async function fetchOrderByContact(locationId, contactId, token) {
  try {
    // Try partially_paid first, then fall back to any unpaid
    const urls = [
      GHL_API + '/payments/orders?altId=' + encodeURIComponent(locationId)
        + '&altType=location&contactId=' + encodeURIComponent(contactId)
        + '&paymentStatus=partially_paid&limit=5',
      GHL_API + '/payments/orders?altId=' + encodeURIComponent(locationId)
        + '&altType=location&contactId=' + encodeURIComponent(contactId)
        + '&paymentStatus=unpaid&limit=5',
    ];
    for (const url of urls) {
      const r = await fetchWithTimeout(url, {
        headers: { 'Authorization': 'Bearer ' + token, 'Version': '2021-07-28' }
      }, 3000);
      if (!r.ok) continue;
      const d = await r.json();
      const orders = d.data || d.orders || [];
      // Prefer calendar orders, newest first
      const sorted = orders
        .filter(o => o.sourceType === 'calendar' || (o.source && o.source.type === 'calendar'))
        .sort((a, b) => (b._id > a._id ? 1 : -1));
      if (sorted.length > 0) return sorted[0];
    }
  } catch(e) { console.error('[balance] fetchOrderByContact:', e.message); }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Type', 'text/html');

  const q          = req.query || {};
  const locationId = q.locationId || '';
  const orderId    = q.orderId    || '';
  const contactId  = q.contactId  || '';

  if (!locationId || (!orderId && !contactId)) {
    return res.end(errorPage('Invalid payment link. Please contact the business.'));
  }

  const cfg   = await getMerchantConfig(locationId).catch(() => null);
  const token = (cfg && cfg.crm_access_token) || '';
  const hasKey = !!(cfg && cfg.handypay_api_key);

  // ── Resolve the GHL order ─────────────────────────────────────────────────────
  let order = null;

  if (orderId) {
    // Direct order ID — use public endpoint (no auth needed)
    order = await fetchPublicOrder(orderId);
  } else if (contactId && token) {
    // contactId from GHL workflow merge field — fetch via authenticated API
    order = await fetchOrderByContact(locationId, contactId, token);
  } else if (contactId && !token) {
    return res.end(errorPage('Payment provider not configured for this account.'));
  }

  if (!order) {
    return res.end(errorPage('No outstanding balance found. Your booking may already be paid in full.'));
  }

  const resolvedOrderId = order._id || orderId;
  const totalAmt   = order.amount || 0;
  const currency   = (order.currency || 'JMD').toUpperCase();
  const serviceName = (order.source && order.source.name) || (order.sourceName) || 'Service';
  const resolvedContactId = order.contactId || order.contact_id || contactId || '';

  if (!totalAmt) {
    return res.end(errorPage('Could not read order amount. Please contact the business.'));
  }

  // ── Calculate remaining ────────────────────────────────────────────────────────
  const depositPaid = await getPaidDeposit(locationId, resolvedOrderId);
  const remaining   = Math.max(0, totalAmt - depositPaid);
  console.log('[balance] order:', resolvedOrderId, 'total:', totalAmt, 'paid:', depositPaid, 'remaining:', remaining, currency);

  if (remaining <= 0) {
    return res.end(paidPage(serviceName, currency));
  }

  // Template vars
  const L   = JSON.stringify(locationId);
  const ORD = JSON.stringify(resolvedOrderId);
  const REM = JSON.stringify(remaining);
  const DEP = JSON.stringify(depositPaid);
  const TOT = JSON.stringify(totalAmt);
  const CUR = JSON.stringify(currency);
  const SVC = JSON.stringify(serviceName);
  const CID = JSON.stringify(resolvedContactId);
  const HAS = JSON.stringify(hasKey);

  const clientJS = `
var L=${L},ORD=${ORD},REM=${REM},DEP=${DEP},TOT=${TOT},CUR=${CUR},SVC=${SVC},CID=${CID},HAS=${HAS};
var done=false,confirmed=false,SID='';

function $el(id){return document.getElementById(id);}
function ss(t){var el=$el('st');if(el)el.textContent=t;}
function fmt(amt,cur){
  var sym=(cur==='USD')?'US$':(cur==='JMD'?'J$':cur+' ');
  return sym+Number(Math.round(amt)).toLocaleString();
}
function init(){
  $el('svc-name').textContent=SVC;
  $el('rem-amt').textContent=fmt(REM,CUR);
  $el('dep-amt').textContent=fmt(DEP,CUR);
  $el('tot-amt').textContent=fmt(TOT,CUR);
  if(!HAS){ss('Payment not configured. Please contact the business.');$el('pay-btn').disabled=true;}
  else{ss('Secure your booking by paying the remaining balance.');}
}
function confirmPayment(){
  if(confirmed)return;confirmed=true;
  ss('\u2705 Balance paid! Your booking is fully confirmed.');
  try{
    window.parent.postMessage(JSON.stringify({type:'custom_element_success_response',chargeId:SID}),'*');
    window.parent.postMessage({type:'custom_element_success_response',chargeId:SID},'*');
  }catch(e){}
  if(window._poll)clearInterval(window._poll);
}
function payBalance(){
  if(done||!HAS)return;
  done=true;
  var w=window.open('','_blank');
  $el('pay-btn').disabled=true;
  ss('Opening HandyPay...');
  fetch('/api/create-native-session',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      locationId:L,amountJMD:REM,currency:CUR,
      description:'Balance: '+SVC,
      entityId:ORD,ghlTransactionId:ORD,contactId:CID,
      paymentType:'balance',paymentChoice:'full'
    })
  }).then(function(r){return r.json();})
  .then(function(d){
    if(!d.checkoutUrl){
      if(w)try{w.close();}catch(e){}
      ss('Error: '+(d.error||'Could not open checkout. Try again.'));
      $el('pay-btn').disabled=false;done=false;return;
    }
    SID=d.sessionId||d.paymentIntentId||'';
    if(w&&!w.closed){w.location.href=d.checkoutUrl;}
    else{
      w=window.open(d.checkoutUrl,'_blank');
      if(!w){ss('\u26a0 Allow popups then tap again.');$el('pay-btn').disabled=false;done=false;return;}
    }
    ss('\u23f3 Complete payment in the HandyPay tab, then return here.');
    window._poll=setInterval(function(){
      if(!SID)return;
      fetch('/api/query?paymentIntentId='+SID)
        .then(function(r){return r.json();})
        .then(function(qd){
          if(qd.success===true)confirmPayment();
          else if(qd.failed===true){
            clearInterval(window._poll);
            ss('Payment not completed. Please try again.');
            $el('pay-btn').disabled=false;done=false;
          }
        }).catch(function(){});
    },3000);
  }).catch(function(){
    if(w)try{w.close();}catch(e){}
    ss('Connection error. Please try again.');
    $el('pay-btn').disabled=false;done=false;
  });
}
window.addEventListener('load',init);
`;

  const css = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8faff;
  display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:16px}
.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);
  max-width:420px;width:100%;padding:28px;text-align:center}
.logo{font-size:36px;margin-bottom:6px}
.brand{font-size:17px;font-weight:800;color:#1a1a1a;margin-bottom:4px}
.svc{font-size:13px;color:#666;margin-bottom:20px;min-height:16px}
.breakdown{background:#f8faff;border-radius:10px;padding:14px 16px;margin-bottom:20px;text-align:left}
.row{display:flex;justify-content:space-between;font-size:13px;color:#555;margin-bottom:6px}
.row.total{font-weight:700;color:#1a1a1a;border-top:1px solid #e2e8f0;padding-top:8px;margin-top:4px}
.row.paid{color:#15803d}
.row.due{color:#b45309;font-size:15px;font-weight:800}
.btn{background:#15803d;color:#fff;border:none;border-radius:10px;padding:14px 24px;
  font-size:15px;font-weight:700;cursor:pointer;width:100%;font-family:inherit;margin-bottom:12px}
.btn:disabled{opacity:.6;cursor:not-allowed}
.st{font-size:13px;color:#555;min-height:18px;line-height:1.5}
`;

  const html = `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pay Remaining Balance — HandyPay</title>
<style>${css}</style>
</head><body><div class="card">
<div class="logo">&#x1F4B3;</div>
<div class="brand">HandyPay</div>
<div class="svc" id="svc-name">Loading...</div>
<div class="breakdown">
  <div class="row total"><span>Total</span><span id="tot-amt"></span></div>
  <div class="row paid"><span>&#x2714; Deposit paid</span><span id="dep-amt"></span></div>
  <div class="row due"><span>Balance due</span><span id="rem-amt"></span></div>
</div>
<button class="btn" id="pay-btn" onclick="payBalance()">Pay Remaining Balance</button>
<div class="st" id="st"></div>
</div>
<script>${clientJS}<\/script></body></html>`;

  res.end(html);
};

function errorPage(msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Error</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;
min-height:100vh;background:#fff8f8;padding:20px}
.box{background:#fff;border-radius:12px;padding:28px;max-width:380px;text-align:center;
box-shadow:0 2px 16px rgba(0,0,0,.08)}
.icon{font-size:40px;margin-bottom:12px}
h2{color:#b91c1c;font-size:18px;margin-bottom:8px}
p{color:#555;font-size:14px;line-height:1.5}</style></head>
<body><div class="box"><div class="icon">⚠️</div><h2>Payment Link Issue</h2><p>${msg}</p></div></body></html>`;
}

function paidPage(serviceName, currency) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Already Paid</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;
min-height:100vh;background:#f0fdf4;padding:20px}
.box{background:#fff;border-radius:12px;padding:28px;max-width:380px;text-align:center;
box-shadow:0 2px 16px rgba(0,0,0,.06)}
.icon{font-size:48px;margin-bottom:12px}
h2{color:#15803d;font-size:20px;margin-bottom:8px}
p{color:#555;font-size:14px;line-height:1.5}</style></head>
<body><div class="box"><div class="icon">✅</div>
<h2>All Paid!</h2>
<p>The full balance for <strong>${serviceName}</strong> has been received. No further payment is needed. See you at your appointment!</p>
</div></body></html>`;
}
