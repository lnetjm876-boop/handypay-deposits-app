// api/pay.js — GHL Custom Payment Provider iframe
//
// ROOT CAUSE: GHL calendar never sends payment_initiate_props postMessage.
// FIX: Server-side order fetch BEFORE building the HTML:
//   1. Get token from Neon; if 401 from GHL, auto-refresh using refresh_token.
//   2. GET /payments/orders (try multiple param combos + hosts) → orderId.
//   3. GET /payments/orders/public/{orderId} (no auth) → deposit amount.
//   4. Embed amount in page JS; client auto-triggers checkout after 1s.
//   5. Still listens for payment_initiate_props (covers invoice flow).
'use strict';

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function fetchWithTimeout(url, opts, ms) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function refreshToken(cfg) {
  const refreshTok = cfg.crm_refresh_token || cfg.ghl_refresh_token || '';
  if (!refreshTok) return null;
  try {
    const r = await fetchWithTimeout('https://services.leadconnectorhq.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.GHL_CLIENT_ID     || '',
        client_secret: process.env.GHL_CLIENT_SECRET || '',
        grant_type:    'refresh_token',
        refresh_token: refreshTok
      })
    }, 4000);
    if (!r.ok) { console.error('[pay] token refresh', r.status); return null; }
    const d = await r.json();
    if (d.access_token) {
      await pool.query(
        'UPDATE merchant_configs SET crm_access_token=$1,crm_refresh_token=$2,ghl_access_token=$1,ghl_refresh_token=$2,updated_at=NOW() WHERE location_id=$3',
        [d.access_token, d.refresh_token || refreshTok, cfg.location_id]
      );
      console.log('[pay] token refreshed ok');
      return d.access_token;
    }
  } catch (e) { console.error('[pay] refresh error:', e.message); }
  return null;
}

async function fetchOrders(locationId, token) {
  const attempts = [
    'https://services.leadconnectorhq.com/payments/orders?altId=' + encodeURIComponent(locationId) + '&altType=location&paymentStatus=unpaid&limit=5',
    'https://services.leadconnectorhq.com/payments/orders?altId=' + encodeURIComponent(locationId) + '&altType=location&limit=5',
    'https://backend.leadconnectorhq.com/payments/orders?altId='  + encodeURIComponent(locationId) + '&altType=location&limit=5',
  ];
  for (const url of attempts) {
    try {
      const r = await fetchWithTimeout(url, {
        headers: { Authorization: 'Bearer ' + token, Version: '2021-07-28' }
      }, 3000);
      console.log('[pay] orders attempt', url.split('?')[1], '->', r.status);
      if (r.ok) {
        const d = await r.json();
        return d.data || d.orders || [];
      }
      if (r.status === 401) return null; // signal: refresh needed
    } catch (e) {
      console.error('[pay] orders fetch error:', e.message);
    }
  }
  return [];
}

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

  // ── Server-side order fetch ───────────────────────────────────────────
  let srvOrderId = '', srvOrderAmt = 0, srvOrderCur = 'JMD', srvOrderDesc = '';
  let tokenStatus = 'no_location';

  if (locationId) {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM merchant_configs WHERE location_id=$1 LIMIT 1',
        [locationId]
      );
      const cfg = rows[0];
      let token = cfg && (cfg.crm_access_token || cfg.ghl_access_token) || '';
      tokenStatus = token ? 'found' : 'missing';
      console.log('[pay] locationId:', locationId, 'token:', tokenStatus, 'len:', token.length);

      if (token) {
        // Try orders API; auto-refresh on 401
        let orders = await fetchOrders(locationId, token);
        if (orders === null) {
          // 401 — try refresh
          tokenStatus = 'refreshing';
          const newTok = await refreshToken(cfg);
          if (newTok) { token = newTok; tokenStatus = 'refreshed'; orders = await fetchOrders(locationId, token) || []; }
          else { tokenStatus = 'refresh_failed'; orders = []; }
        }
        console.log('[pay] orders count:', Array.isArray(orders) ? orders.length : 0, 'tokenStatus:', tokenStatus);

        // Pick most-recent calendar order
        const calOrder = Array.isArray(orders)
          ? (orders.find(o => o.sourceType === 'calendar' || (o.source && o.source.type === 'calendar')) || orders[0])
          : null;
        const orderId = calOrder ? (calOrder._id || '') : '';
        console.log('[pay] picked orderId:', orderId);

        // Fetch public order for deposit amount
        if (orderId) {
          try {
            const pr = await fetchWithTimeout(
              'https://backend.leadconnectorhq.com/payments/orders/public/' + orderId, {}, 2000
            );
            if (pr.ok) {
              const pd = await pr.json();
              srvOrderAmt  = (pd.paymentSummary && pd.paymentSummary.initialAmount > 0)
                ? pd.paymentSummary.initialAmount : (pd.amount || 0);
              srvOrderCur  = pd.currency || 'JMD';
              srvOrderDesc = (pd.source && pd.source.name) || 'Booking Deposit';
              srvOrderId   = orderId;
              console.log('[pay] deposit:', srvOrderAmt, srvOrderCur);
            }
          } catch (pe) { console.error('[pay] public order error:', pe.message); }
        }
      } else if (cfg) {
        tokenStatus = 'no_token_in_db';
        // Try refresh even without access token if we have a refresh token
        const refreshTok = cfg.crm_refresh_token || cfg.ghl_refresh_token || '';
        if (refreshTok) {
          tokenStatus = 'refresh_only';
          const newTok = await refreshToken(cfg);
          if (newTok) {
            tokenStatus = 'refreshed_from_scratch';
            const orders = await fetchOrders(locationId, newTok) || [];
            const calOrder = orders.find(o => o.sourceType === 'calendar' || (o.source && o.source.type === 'calendar')) || orders[0];
            const orderId = calOrder ? (calOrder._id || '') : '';
            if (orderId) {
              try {
                const pr = await fetchWithTimeout('https://backend.leadconnectorhq.com/payments/orders/public/' + orderId, {}, 2000);
                if (pr.ok) {
                  const pd = await pr.json();
                  srvOrderAmt  = (pd.paymentSummary && pd.paymentSummary.initialAmount > 0) ? pd.paymentSummary.initialAmount : (pd.amount || 0);
                  srvOrderCur  = pd.currency || 'JMD';
                  srvOrderDesc = (pd.source && pd.source.name) || 'Booking Deposit';
                  srvOrderId   = orderId;
                }
              } catch (pe) {}
            }
          }
        }
      }
    } catch (e) {
      tokenStatus = 'db_error';
      console.error('[pay] server error:', e.message);
    }
  }

  console.log('[pay] final: srvAmt=', srvOrderAmt, 'orderId=', srvOrderId, 'tokenStatus=', tokenStatus);

  const L        = JSON.stringify(locationId);
  const URL_AMT  = JSON.stringify(urlAmount);
  const URL_CUR  = JSON.stringify(urlCurrency);
  const URL_TXN  = JSON.stringify(urlTxId);
  const SRV_AMT  = JSON.stringify(srvOrderAmt);
  const SRV_CUR  = JSON.stringify(srvOrderCur);
  const SRV_DESC = JSON.stringify(srvOrderDesc);
  const SRV_ORD  = JSON.stringify(srvOrderId);
  const SRV_STATUS = JSON.stringify(tokenStatus);

  const clientJS = `
var L=${L},URL_AMT=${URL_AMT},URL_CUR=${URL_CUR},URL_TXN=${URL_TXN};
var SRV_AMT=${SRV_AMT},SRV_CUR=${SRV_CUR},SRV_DESC=${SRV_DESC},SRV_ORD=${SRV_ORD};
var SRV_STATUS=${SRV_STATUS};
var done=false,confirmed=false,SID='',poll=null,AMT=0,DESC='Deposit',INV='';
window._GHL_TXN='';
var dbgLines=[];
function $el(id){return document.getElementById(id);}
function ss(t){$el('s').textContent=t;}
function dlog(s){
  dbgLines.push(s);
  $el('dbg').innerHTML=dbgLines.slice(-12).join('<br>');
  try{fetch('/api/debug-log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:'pay',data:s})}).catch(function(){});}catch(e){}
}
function applyAmt(amt,cur,desc,txn,ord){
  if(done)return;
  AMT=parseFloat(amt)||0;if(!AMT)return;
  DESC=desc||'Deposit';INV=ord||txn||'';window._GHL_TXN=txn||ord||'';
  dlog('\u2714 Amount: J$'+Math.round(AMT)+' ['+DESC+']');
  $el('a').textContent='J$'+Math.round(AMT).toLocaleString();
  $el('a').style.display='block';
  $el('l').textContent=DESC;
  $el('b').style.display='block';
  setTimeout(openHP,500);
}
function confirmPayment(){
  if(confirmed)return;confirmed=true;clearInterval(poll);
  dlog('\u2705 Confirmed!');ss('\u2705 Payment confirmed!');
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
    dlog('\u23f3 '+SID.substring(0,14)+'...');
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
  }).catch(function(e){dlog('\u274c '+e.message);ss('Error');$el('b').disabled=false;done=false;});
}
(function init(){
  window.parent.postMessage(JSON.stringify({type:'custom_element_loaded'}),'*');
  window.parent.postMessage({type:'custom_element_loaded'},'*');
  dlog((window!==window.top?'\u2705 iframe':'\u26a0 standalone'));
  dlog('tokenStatus: '+SRV_STATUS);
  if(SRV_AMT>0){
    dlog('\u26a1 Server: J$'+SRV_AMT+' ['+SRV_DESC+']');
    setTimeout(function(){if(!done&&AMT===0)applyAmt(SRV_AMT,SRV_CUR,SRV_DESC,SRV_ORD,SRV_ORD);},1000);
  } else {
    dlog('\u23f3 no server order ('+SRV_STATUS+') \u2014 waiting for postMessage...');
  }
  if(URL_AMT>0)applyAmt(URL_AMT,URL_CUR,'',URL_TXN,URL_TXN);
  setTimeout(function(){if(!done&&AMT===0)dlog('\u26a0 10s: still no amount');},10000);
})();
window.addEventListener('message',function(e){
  var data;try{data=typeof e.data==='object'?e.data:JSON.parse(e.data);}catch(x){return;}
  if(!data)return;
  var t=data.type||'';
  if(t==='PAYMENT_SUCCESS'){confirmPayment();return;}
  if(t==='payment_initiate_props'){
    dlog('\u2728 payment_initiate_props amt='+(data.amount||'?'));
    var pAmt=parseFloat(data.amount||data.amountJMD||0);
    var pOrd=data.entityId||data.invoiceId||data.orderId||'';
    var pTxn=data.transactionId||data.paymentIntentId||'';
    if(pAmt>0)applyAmt(pAmt>=100000?Math.round(pAmt/100):pAmt,data.currency,data.description||data.name,pTxn,pOrd);
    else if(pOrd){fetch('/api/ghl-order?orderId='+encodeURIComponent(pOrd)).then(function(r){return r.json();}).then(function(d){if(d.amount>0)applyAmt(d.amount,d.currency,d.description,d.transactionId,d.orderId);}).catch(function(){});}
  }
  dlog('\u1f4e8 msg:'+t);
});
`;

  const html = `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandyPay</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f8faff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;width:100%;padding:40px;text-align:center}.logo{font-size:48px;margin-bottom:8px}h2{font-size:20px;font-weight:800;color:#1a1a1a;margin-bottom:16px}.amt{font-size:32px;font-weight:800;color:#15803d;margin-bottom:8px;display:none}.lbl{font-size:14px;color:#666;margin-bottom:24px}.btn{background:#15803d;color:#fff;border:none;border-radius:10px;padding:14px 28px;font-size:16px;font-weight:700;cursor:pointer;width:100%;display:none;margin-bottom:8px}.btn:disabled{opacity:.6;cursor:not-allowed}.st{font-size:14px;color:#555;margin-top:16px;min-height:20px}#dbg{margin-top:16px;padding:8px;background:#f1f5f9;border-radius:8px;font-size:10px;font-family:monospace;color:#555;text-align:left;word-break:break-all;line-height:1.6}</style>
</head><body><div class="card"><div class="logo">&#x1F4B3;</div><h2>HandyPay</h2><div class="amt" id="a"></div><div class="lbl" id="l">Loading payment details...</div><button class="btn" id="b" onclick="openHP()">Open HandyPay Checkout</button><div class="st" id="s"></div><div id="dbg">Starting...</div></div>
<script>${clientJS}<\/script></body></html>`;

  res.end(html);
};
