// api/pay.js — GHL Custom Payment Provider iframe
//
// ROOT CAUSE: GHL calendar never sends payment_initiate_props postMessage.
// FIX: Server-side fetch of pending GHL order BEFORE building the HTML.
//   Step 1: GET /payments/orders (auth) → most-recent calendar order → orderId
//   Step 2: GET /payments/orders/public/{orderId} (no auth) → deposit amount
//   Embed amount + orderId in page JS. Client auto-triggers checkout after 1s.
//   Still listens for payment_initiate_props as fallback for invoice surfaces.
'use strict';

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const q          = req.query || {};
  const locationId = q.locationId   || '';
  const urlAmount  = parseFloat(q.amount || q.amountJMD || '0') || 0;
  const urlCurrency= (q.currency || 'JMD').toUpperCase();
  const urlTxId    = q.paymentIntentId || q.transactionId || q.orderId || q.entityId || '';

  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Type', 'text/html');

  // ── Server-side: fetch pending calendar order ────────────────────────────────────
  let srvOrderId = '', srvOrderAmt = 0, srvOrderCur = 'JMD', srvOrderDesc = '';

  if (locationId) {
    try {
      // Step 1: get auth token from Neon
      const { rows } = await pool.query(
        'SELECT crm_access_token, ghl_access_token FROM merchant_configs WHERE location_id=$1 LIMIT 1',
        [locationId]
      );
      const cfg   = rows[0];
      const token = cfg && (cfg.crm_access_token || cfg.ghl_access_token) || '';
      console.log('[pay] token found:', !!token, 'locationId:', locationId);

      if (token) {
        // Step 2: list unpaid orders for this location
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        let orderId = '';
        try {
          const r = await fetch(
            'https://services.leadconnectorhq.com/payments/orders'
              + '?altId=' + encodeURIComponent(locationId)
              + '&altType=location&paymentStatus=unpaid&limit=5',
            { headers: { Authorization: 'Bearer ' + token, Version: '2021-07-28' }, signal: ctrl.signal }
          );
          clearTimeout(timer);
          console.log('[pay] orders list status:', r.status);
          if (r.ok) {
            const d      = await r.json();
            // GHL returns { data: [...] } on orders list
            const orders = d.data || d.orders || [];
            console.log('[pay] orders count:', orders.length);
            // Prefer calendar-source order; fall back to newest
            const ord = orders.find(o => o.sourceType === 'calendar' || (o.source && o.source.type === 'calendar'))
              || orders[0];
            if (ord) {
              orderId = ord._id || '';
              console.log('[pay] picked orderId:', orderId);
            }
          }
        } catch (fe) {
          clearTimeout(timer);
          console.error('[pay] orders list error:', fe.message);
        }

        // Step 3: fetch public order for deposit amount (no auth needed)
        if (orderId) {
          try {
            const ctrl2  = new AbortController();
            const timer2 = setTimeout(() => ctrl2.abort(), 2000);
            const pr = await fetch(
              'https://backend.leadconnectorhq.com/payments/orders/public/' + orderId,
              { signal: ctrl2.signal }
            );
            clearTimeout(timer2);
            if (pr.ok) {
              const pd = await pr.json();
              // initialAmount = deposit; amount = full price
              srvOrderAmt  = (pd.paymentSummary && pd.paymentSummary.initialAmount > 0)
                ? pd.paymentSummary.initialAmount
                : (pd.amount || 0);
              srvOrderCur  = pd.currency || 'JMD';
              srvOrderDesc = (pd.source && pd.source.name) || 'Booking Deposit';
              srvOrderId   = orderId;
              console.log('[pay] deposit amt:', srvOrderAmt, srvOrderCur, 'desc:', srvOrderDesc);
            }
          } catch (pe) {
            console.error('[pay] public order error:', pe.message);
          }
        }
      }
    } catch (e) {
      console.error('[pay] DB/fetch error:', e.message);
    }
  }

  // Embed for client JS
  const L        = JSON.stringify(locationId);
  const URL_AMT  = JSON.stringify(urlAmount);
  const URL_CUR  = JSON.stringify(urlCurrency);
  const URL_TXN  = JSON.stringify(urlTxId);
  const SRV_AMT  = JSON.stringify(srvOrderAmt);   // already in JMD whole units
  const SRV_CUR  = JSON.stringify(srvOrderCur);
  const SRV_DESC = JSON.stringify(srvOrderDesc);
  const SRV_ORD  = JSON.stringify(srvOrderId);

  // ── Client JS ────────────────────────────────────────────────────────────────────────────
  const clientJS = `
var L=${L},URL_AMT=${URL_AMT},URL_CUR=${URL_CUR},URL_TXN=${URL_TXN};
var SRV_AMT=${SRV_AMT},SRV_CUR=${SRV_CUR},SRV_DESC=${SRV_DESC},SRV_ORD=${SRV_ORD};
var done=false,confirmed=false,SID='',poll=null,AMT=0,DESC='Deposit',INV='';
window._GHL_TXN='';
var dbgLines=[];
function $el(id){return document.getElementById(id);}
function ss(t){$el('s').textContent=t;}
function dlog(s){
  dbgLines.push(s);
  $el('dbg').innerHTML=dbgLines.slice(-10).join('<br>');
  try{fetch('/api/debug-log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:'pay',data:s})}).catch(function(){});}catch(e){}
}
// jmd: converts raw amount to JMD whole units
// GHL list API returns whole JMD; payment_initiate_props may send cents
// SRV_AMT is already whole JMD (from public order endpoint) — skip jmd() for it
function jmd(raw,cur){
  var n=parseFloat(raw)||0;if(!n)return 0;
  cur=(cur||'').toUpperCase();
  if(cur==='USD')return Math.round((n>=100?n/100:n)*155);
  // JMD: only divide by 100 if it looks like cents (very large number from postMessage)
  return n>=100000?Math.round(n/100):n;
}
function applyAmt(amt,cur,desc,txn,ord){
  if(done)return;
  AMT=parseFloat(amt)||0;if(!AMT)return;  // SRV_AMT already in JMD — use directly
  DESC=desc||'Deposit';INV=ord||txn||'';window._GHL_TXN=txn||ord||'';
  dlog('\u2714 Amount: J$'+Math.round(AMT)+' ['+DESC+']');
  $el('a').textContent='J$'+Math.round(AMT).toLocaleString();
  $el('a').style.display='block';
  $el('l').textContent=DESC;
  $el('b').style.display='block';
  setTimeout(openHP,500);
}
function applySrv(){
  if(done||AMT>0)return;
  if(SRV_AMT>0){
    dlog('\u26a1 Using server order J$'+SRV_AMT+' ['+SRV_DESC+']');
    applyAmt(SRV_AMT,SRV_CUR,SRV_DESC,SRV_ORD,SRV_ORD);
  }
}
function confirmPayment(){
  if(confirmed)return;confirmed=true;clearInterval(poll);
  dlog('\u2705 Confirmed! Notifying GHL...');ss('\u2705 Payment confirmed!');
  var cid=window._GHL_TXN||SID;
  window.parent.postMessage(JSON.stringify({type:'custom_element_success_response',chargeId:cid}),'*');
  window.parent.postMessage({type:'custom_element_success_response',chargeId:cid},'*');
  setTimeout(function(){
    window.parent.postMessage(JSON.stringify({type:'custom_element_close_response'}),'*');
    window.parent.postMessage({type:'custom_element_close_response'},'*');
  },1500);
}
function openHP(){
  if(done)return;done=true;
  $el('b').disabled=true;ss('Opening HandyPay...');
  dlog('\u1f680 Session J$'+Math.round(AMT));
  fetch('/api/create-native-session',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({locationId:L,amountJMD:AMT,description:DESC,entityId:INV,ghlTransactionId:window._GHL_TXN||'',paymentType:'calendar'})
  }).then(function(r){return r.json();})
  .then(function(d){
    if(!d.checkoutUrl){
      dlog('\u274c No URL: '+(d.error||'?'));ss('Error: '+(d.error||'No checkout URL'));
      window.parent.postMessage(JSON.stringify({type:'custom_element_error_response',error:{description:d.error||'Error'}}),'*');
      $el('b').disabled=false;done=false;return;
    }
    SID=d.sessionId||d.paymentIntentId||'';
    dlog('\u23f3 Session '+SID.substring(0,12)+'...');
    var w=window.open(d.checkoutUrl,'_blank');
    if(!w){ss('Popup blocked \u2014 allow popups');$el('b').disabled=false;done=false;return;}
    ss('\u23f3 HandyPay open in new tab. Return here after paying.');
    poll=setInterval(function(){
      if(!SID)return;
      fetch('/api/query?paymentIntentId='+SID)
        .then(function(r){return r.json();})
        .then(function(qd){
          if(qd.success===true)confirmPayment();
          else if(qd.failed===true){clearInterval(poll);ss('Failed. Try again.');done=false;$el('b').disabled=false;}
        }).catch(function(){});
    },3000);
  }).catch(function(e){dlog('\u274c err: '+e.message);ss('Error: '+e.message);$el('b').disabled=false;done=false;});
}
// ── INIT ─────────────────────────────────────────────────────
(function init(){
  window.parent.postMessage(JSON.stringify({type:'custom_element_loaded'}),'*');
  window.parent.postMessage({type:'custom_element_loaded'},'*');
  dlog((window!==window.top?'\u2705 iframe':'\u26a0 standalone')+' | '+location.search);
  if(SRV_AMT>0){
    dlog('\u26a1 Server: J$'+SRV_AMT+' id:'+SRV_ORD.substring(0,10)+'...');
    // Wait 1s so payment_initiate_props wins for invoice surfaces
    setTimeout(applySrv,1000);
  } else {
    dlog('\u23f3 No server order — waiting for postMessage...');
  }
  if(URL_AMT>0)applyAmt(URL_AMT,URL_CUR,'',URL_TXN,URL_TXN);
  setTimeout(function(){if(!done&&AMT===0)dlog('\u26a0 10s: still no amount');},10000);
})();
// ── MESSAGE LISTENER ──────────────────────────────────────────────
 window.addEventListener('message',function(e){
  var data;try{data=typeof e.data==='object'?e.data:JSON.parse(e.data);}catch(x){return;}
  if(!data)return;
  var t=data.type||'';
  if(t==='PAYMENT_SUCCESS'){confirmPayment();return;}
  if(t==='payment_initiate_props'){
    dlog('\u2728 payment_initiate_props! amt='+(data.amount||'?'));
    var pAmt=data.amount||data.amountJMD||0;
    var pOrd=data.entityId||data.invoiceId||data.orderId||'';
    var pTxn=data.transactionId||data.paymentIntentId||'';
    if(pAmt>0)applyAmt(jmd(pAmt,data.currency),data.currency,data.description||data.name,pTxn,pOrd);
    else if(pOrd){
      fetch('/api/ghl-order?orderId='+encodeURIComponent(pOrd))
        .then(function(r){return r.json();})
        .then(function(d){if(d.amount>0)applyAmt(d.amount,d.currency,d.description,d.transactionId,d.orderId);}).catch(function(){});
    }
  }
  dlog('\u1f4e8 msg:'+t+' from:'+e.origin.substring(0,30));
});
`;

  const html = `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandyPay</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f8faff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;width:100%;padding:40px;text-align:center}
.logo{font-size:48px;margin-bottom:8px}
h2{font-size:20px;font-weight:800;color:#1a1a1a;margin-bottom:16px}
.amt{font-size:32px;font-weight:800;color:#15803d;margin-bottom:8px;display:none}
.lbl{font-size:14px;color:#666;margin-bottom:24px}
.btn{background:#15803d;color:#fff;border:none;border-radius:10px;padding:14px 28px;font-size:16px;font-weight:700;cursor:pointer;width:100%;display:none;margin-bottom:8px}
.btn:disabled{opacity:.6;cursor:not-allowed}
.st{font-size:14px;color:#555;margin-top:16px;min-height:20px}
#dbg{margin-top:16px;padding:8px;background:#f1f5f9;border-radius:8px;font-size:10px;font-family:monospace;color:#555;text-align:left;word-break:break-all;line-height:1.6}
</style></head><body>
<div class="card">
<div class="logo">&#x1F4B3;</div>
<h2>HandyPay</h2>
<div class="amt" id="a"></div>
<div class="lbl" id="l">Loading payment details...</div>
<button class="btn" id="b" onclick="openHP()">Open HandyPay Checkout</button>
<div class="st" id="s"></div>
<div id="dbg">Starting...</div>
</div>
<script>${clientJS}<\/script>
</body></html>`;

  res.end(html);
};
