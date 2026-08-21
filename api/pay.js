// api/pay.js — GHL Custom Payment Provider iframe
//
// ROOT CAUSE: GHL calendar never sends payment_initiate_props postMessage.
// FIX: Server-side order fetch BEFORE building the HTML.
//   - Token in Neon expired (26h stale). Auto-refresh via crm_refresh_token.
//   - DB schema has crm_access_token/crm_refresh_token (NO ghl_* columns).
//   - After refresh, fetch pending calendar order, get deposit amount from public API.
//   - Embed amount in page JS. Client shows button when ready.
//   - User clicks button -> window.open() fires from user gesture (not blocked).
//   - Poll detects payment -> custom_element_success_response -> GHL confirms booking.
//
// KEY FINDING: GHL payment iframe has sandbox="" (no restrictions), allow="payment".
// window.open() IS allowed but ONLY from direct user interaction (not setTimeout).
// Auto-trigger (setTimeout -> openHP) was blocked by browser popup blocker.
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
  } catch (e) { clearTimeout(timer); throw e; }
}

async function refreshToken(locationId, refreshTok) {
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
    }, 5000);
    if (!r.ok) { const e = await r.text(); console.error('[pay] refresh', r.status, e.substring(0,100)); return null; }
    const d = await r.json();
    if (d.access_token) {
      // IMPORTANT: only update columns that actually exist in schema
      // Schema has crm_access_token + crm_refresh_token (NO ghl_* columns)
      await pool.query(
        'UPDATE merchant_configs SET crm_access_token=$1, crm_refresh_token=$2, updated_at=NOW() WHERE location_id=$3',
        [d.access_token, d.refresh_token || refreshTok, locationId]
      );
      console.log('[pay] token refreshed ✅');
      return d.access_token;
    }
    console.error('[pay] refresh: no access_token in response');
  } catch (e) { console.error('[pay] refresh error:', e.message); }
  return null;
}

async function fetchOrders(locationId, token) {
  const urls = [
    'https://services.leadconnectorhq.com/payments/orders?altId=' + encodeURIComponent(locationId) + '&altType=location&paymentStatus=unpaid&limit=5',
    'https://services.leadconnectorhq.com/payments/orders?altId=' + encodeURIComponent(locationId) + '&altType=location&limit=5',
  ];
  for (const url of urls) {
    try {
      const r = await fetchWithTimeout(url, { headers: { Authorization: 'Bearer ' + token, Version: '2021-07-28' } }, 3000);
      console.log('[pay] orders', r.status, url.split('?')[1]);
      if (r.ok) { const d = await r.json(); return d.data || d.orders || []; }
      if (r.status === 401) return null; // needs refresh
    } catch (e) { console.error('[pay] orders error:', e.message); }
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

  // ── Server-side order fetch ──────────────────────────────────────────────────
  let srvOrderId = '', srvOrderAmt = 0, srvOrderCur = 'JMD', srvOrderDesc = '';
  let tokenStatus = 'no_location';

  if (locationId) {
    try {
      const { rows } = await pool.query(
        'SELECT crm_access_token, crm_refresh_token, location_id FROM merchant_configs WHERE location_id=$1 LIMIT 1',
        [locationId]
      );
      const cfg = rows[0];
      let token       = (cfg && cfg.crm_access_token) || '';
      const refreshTok= (cfg && cfg.crm_refresh_token) || '';
      tokenStatus = token ? 'found' : (refreshTok ? 'token_missing_has_refresh' : 'not_configured');
      console.log('[pay] locationId:', locationId, 'token len:', token.length, 'refresh len:', refreshTok.length);

      if (token) {
        let orders = await fetchOrders(locationId, token);
        if (orders === null) {
          // 401 — refresh the token
          tokenStatus = 'refreshing';
          const newTok = await refreshToken(locationId, refreshTok);
          if (newTok) { token = newTok; tokenStatus = 'refreshed'; orders = await fetchOrders(locationId, token) || []; }
          else { tokenStatus = 'refresh_failed'; orders = []; }
        }
        console.log('[pay] orders count:', Array.isArray(orders) ? orders.length : 0);

        // Sort by _id descending (MongoDB ObjectID encodes timestamp)
        // to pick the most recently created order
        const sortedOrders = Array.isArray(orders)
          ? [...orders].sort((a, b) => ((b._id || '') > (a._id || '') ? 1 : -1))
          : [];

        const calOrder = sortedOrders.find(o => o.sourceType === 'calendar' || (o.source && o.source.type === 'calendar'))
          || sortedOrders[0]
          || null;
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
              console.log('[pay] ✅ deposit:', srvOrderAmt, srvOrderCur, 'orderId:', orderId);
            }
          } catch (pe) { console.error('[pay] public order:', pe.message); }
        }
      } else if (refreshTok) {
        // No access token but have refresh token — try refresh
        tokenStatus = 'refresh_only';
        const newTok = await refreshToken(locationId, refreshTok);
        if (newTok) {
          tokenStatus = 'refreshed_cold';
          const orders = await fetchOrders(locationId, newTok) || [];
          const sortedOrders = [...orders].sort((a, b) => ((b._id || '') > (a._id || '') ? 1 : -1));
          const calOrder = sortedOrders.find(o => o.sourceType === 'calendar' || (o.source && o.source.type === 'calendar')) || sortedOrders[0];
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
                console.log('[pay] ✅ deposit (cold refresh):', srvOrderAmt, srvOrderCur);
              }
            } catch (pe) {}
          }
        }
      }
    } catch (e) {
      tokenStatus = 'db_error:' + e.message.substring(0, 50);
      console.error('[pay] db error:', e.message);
    }
  }

  console.log('[pay] final srvAmt:', srvOrderAmt, 'tokenStatus:', tokenStatus);

  const L         = JSON.stringify(locationId);
  const URL_AMT   = JSON.stringify(urlAmount);
  const URL_CUR   = JSON.stringify(urlCurrency);
  const URL_TXN   = JSON.stringify(urlTxId);
  const SRV_AMT   = JSON.stringify(srvOrderAmt);
  const SRV_CUR   = JSON.stringify(srvOrderCur);
  const SRV_DESC  = JSON.stringify(srvOrderDesc);
  const SRV_ORD   = JSON.stringify(srvOrderId);
  const SRV_STAT  = JSON.stringify(tokenStatus);

  const clientJS = `
var L=${L},URL_AMT=${URL_AMT},URL_CUR=${URL_CUR},URL_TXN=${URL_TXN};
var SRV_AMT=${SRV_AMT},SRV_CUR=${SRV_CUR},SRV_DESC=${SRV_DESC},SRV_ORD=${SRV_ORD},SRV_STAT=${SRV_STAT};
var done=false,confirmed=false,SID='',poll=null,AMT=0,DESC='Deposit',INV='';
window._GHL_TXN='';
var dbgLines=[];
function $el(id){return document.getElementById(id);}
function ss(t){$el('s').textContent=t;}
function dlog(s){dbgLines.push(s);$el('dbg').innerHTML=dbgLines.slice(-12).join('<br>');try{fetch('/api/debug-log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:'pay',data:s})}).catch(function(){});}catch(e){}}
function applyAmt(amt,cur,desc,txn,ord){
  if(done)return;
  AMT=parseFloat(amt)||0;if(!AMT)return;
  DESC=desc||'Deposit';INV=ord||txn||'';window._GHL_TXN=txn||ord||'';
  dlog('\u2714 Amount: J$'+Math.round(AMT)+' ['+DESC+']');
  $el('a').textContent='J$'+Math.round(AMT).toLocaleString();
  $el('a').style.display='block';
  $el('l').textContent=DESC;
  $el('b').style.display='block';
  // DO NOT auto-trigger openHP() here.
  // window.open() is only allowed by the browser when called from a direct
  // user interaction (button click). Auto-trigger via setTimeout is blocked
  // by the browser popup blocker even though GHL iframe has no sandbox.
  ss('Click to pay J$'+Math.round(AMT).toLocaleString());
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
  dlog('\u1f680 J$'+Math.round(AMT));
  fetch('/api/create-native-session',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({locationId:L,amountJMD:AMT,description:DESC,entityId:INV,ghlTransactionId:window._GHL_TXN||'',paymentType:'calendar'})
  }).then(function(r){return r.json();})
  .then(function(d){
    if(!d.checkoutUrl){
      dlog('\u274c '+(d.error||'?'));ss('Error: '+(d.error||'No checkout URL'));
      window.parent.postMessage(JSON.stringify({type:'custom_element_error_response',error:{description:d.error||'Error'}}),'*');
      $el('b').disabled=false;done=false;return;
    }
    SID=d.sessionId||d.paymentIntentId||'';
    dlog('\u23f3 '+SID.substring(0,14)+'...');
    // Open HandyPay in a new tab.
    // This MUST be called from a direct button click (user gesture) so the
    // browser allows window.open(). GHL iframe has no sandbox restrictions.
    var w=window.open(d.checkoutUrl,'_blank');
    if(!w){
      // Popup blocked - show message and let user retry by clicking the button
      dlog('\u26a0 Popup blocked');
      ss('\u26a0 Allow popups for this site, then click the button again.');
      $el('b').disabled=false;done=false;return;
    }
    ss('\u23f3 HandyPay open. Complete payment and return here.');
    dlog('\u2705 Tab opened: '+SID.substring(0,14)+'...');
    // Poll every 3s for payment completion
    poll=setInterval(function(){
      if(!SID)return;
      fetch('/api/query?paymentIntentId='+SID).then(function(r){return r.json();}).then(function(qd){
        if(qd.success===true)confirmPayment();
        else if(qd.failed===true){clearInterval(poll);ss('Payment failed. Try again.');done=false;$el('b').disabled=false;}
      }).catch(function(){});
    },3000);
  }).catch(function(e){dlog('\u274c '+e.message);ss('Error');$el('b').disabled=false;done=false;});
}
(function init(){
  window.parent.postMessage(JSON.stringify({type:'custom_element_loaded'}),'*');
  window.parent.postMessage({type:'custom_element_loaded'},'*');
  dlog((window!==window.top?'\u2705 iframe':'\u26a0 standalone')+' | status:'+SRV_STAT);
  if(SRV_AMT>0){
    dlog('\u26a1 Server: J$'+SRV_AMT+' ['+SRV_DESC+']');
    setTimeout(function(){if(!done&&AMT===0)applyAmt(SRV_AMT,SRV_CUR,SRV_DESC,SRV_ORD,SRV_ORD);},1000);
  } else {
    dlog('\u23f3 no server order ('+SRV_STAT+')');
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
    if(pAmt>0)applyAmt(pAmt>=100000?Math.round(pAmt/100):pAmt,data.currency,data.description||data.name,data.transactionId||data.paymentIntentId||'',data.entityId||data.invoiceId||data.orderId||'');
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
