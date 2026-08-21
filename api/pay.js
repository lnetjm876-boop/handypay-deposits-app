// api/pay.js — GHL Custom Payment Provider iframe
// v3: Full/Deposit choice + live currency + iOS popup fix + no debug overlay
//
// KEY FINDINGS (preserved from v2):
//   - GHL calendar NEVER sends payment_initiate_props postMessage
//   - Server-side order fetch is the only viable approach
//   - GHL iframe sandbox="" (no restrictions), allow="payment"
//   - window.open() must fire from direct user click (not setTimeout)
//   - Sort orders by _id DESC (MongoDB ObjectID = newest first)
//
// v3 CHANGES:
//   - Full/Deposit choice: reads pd.amount (full) vs pd.paymentSummary.initialAmount (deposit)
//     Shows two cards when amounts differ, single button when equal (fixed deposit mode)
//   - iOS Safari fix: window.open('','_blank') called synchronously in button click
//     handler, then navigated to checkoutUrl after session creation
//   - Live currency: reads pd.currency from GHL order, sends to /api/create-native-session
//   - Debug overlay removed: no #dbg div or dlog() in production
//   - Pool config: max:2 to reduce connection pressure in serverless
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
  } catch (e) { clearTimeout(timer); throw e; }
}

async function refreshToken(locationId, refreshTok) {
  if (!refreshTok) return null;
  try {
    const r = await fetchWithTimeout(GHL_API + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.GHL_CLIENT_ID     || '',
        client_secret: process.env.GHL_CLIENT_SECRET || '',
        grant_type:    'refresh_token',
        refresh_token: refreshTok
      })
    }, 5000);
    if (!r.ok) { console.error('[pay] refresh', r.status); return null; }
    const d = await r.json();
    if (d.access_token) {
      await pool.query(
        'UPDATE merchant_configs SET crm_access_token=$1, crm_refresh_token=$2, updated_at=NOW() WHERE location_id=$3',
        [d.access_token, d.refresh_token || refreshTok, locationId]
      );
      console.log('[pay] token refreshed ✅');
      return d.access_token;
    }
  } catch (e) { console.error('[pay] refresh error:', e.message); }
  return null;
}

async function fetchOrders(locationId, token) {
  const urls = [
    GHL_API + '/payments/orders?altId=' + encodeURIComponent(locationId) + '&altType=location&paymentStatus=unpaid&limit=5',
    GHL_API + '/payments/orders?altId=' + encodeURIComponent(locationId) + '&altType=location&limit=5',
  ];
  for (const url of urls) {
    try {
      const r = await fetchWithTimeout(url, { headers: { Authorization: 'Bearer ' + token, Version: '2021-07-28' } }, 3000);
      console.log('[pay] orders', r.status, url.split('?')[1]);
      if (r.ok) { const d = await r.json(); return d.data || d.orders || []; }
      if (r.status === 401) return null;
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

  res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Type', 'text/html');

  // ── Server-side order fetch ───────────────────────────────────────────────────────────────────────────
  let srvOrderId = '', srvDepAmt = 0, srvFullAmt = 0, srvOrderCur = 'JMD', srvOrderDesc = '';
  let tokenStatus = 'no_location';

  if (locationId) {
    try {
      const { rows } = await pool.query(
        'SELECT crm_access_token, crm_refresh_token FROM merchant_configs WHERE location_id=$1 LIMIT 1',
        [locationId]
      );
      const cfg      = rows[0];
      let token      = (cfg && cfg.crm_access_token) || '';
      const refreshTok = (cfg && cfg.crm_refresh_token) || '';
      tokenStatus    = token ? 'found' : (refreshTok ? 'refresh_only' : 'not_configured');
      console.log('[pay] locationId:', locationId, 'token len:', token.length, 'refresh len:', refreshTok.length);

      if (token) {
        let orders = await fetchOrders(locationId, token);
        if (orders === null) {
          tokenStatus = 'refreshing';
          const newTok = await refreshToken(locationId, refreshTok);
          if (newTok) { token = newTok; tokenStatus = 'refreshed'; orders = await fetchOrders(locationId, token) || []; }
          else { tokenStatus = 'refresh_failed'; orders = []; }
        }
        console.log('[pay] orders count:', Array.isArray(orders) ? orders.length : 0);

        // Sort by _id descending (MongoDB ObjectID encodes timestamp = newest first)
        const sorted = Array.isArray(orders)
          ? [...orders].sort((a, b) => ((b._id || '') > (a._id || '') ? 1 : -1))
          : [];

        const calOrder = sorted.find(o => o.sourceType === 'calendar' || (o.source && o.source.type === 'calendar'))
          || sorted[0] || null;
        const orderId  = calOrder ? (calOrder._id || '') : '';

        if (orderId) {
          try {
            const pr = await fetchWithTimeout('https://backend.leadconnectorhq.com/payments/orders/public/' + orderId, {}, 2000);
            if (pr.ok) {
              const pd       = await pr.json();
              // depAmt = what GHL wants collected now (initialAmount = deposit)
              // totalAmt = full service price (amount field on the order)
              const depAmt   = (pd.paymentSummary && pd.paymentSummary.initialAmount > 0) ? pd.paymentSummary.initialAmount : 0;
              const totalAmt = pd.amount || 0;
              srvDepAmt      = depAmt || totalAmt;         // deposit to show/charge
              // Only expose full option when GHL set % deposit (amounts are genuinely different)
              srvFullAmt     = (totalAmt > srvDepAmt && srvDepAmt > 0) ? totalAmt : 0;
              srvOrderCur    = (pd.currency || 'JMD').toUpperCase();
              srvOrderDesc   = (pd.source && pd.source.name) || 'Booking Deposit';
              srvOrderId     = orderId;
              console.log('[pay] ✅ dep:', srvDepAmt, 'full:', srvFullAmt, srvOrderCur, 'orderId:', orderId);
            }
          } catch (pe) { console.error('[pay] public order:', pe.message); }
        }
      } else if (refreshTok) {
        tokenStatus = 'refresh_only';
        const newTok = await refreshToken(locationId, refreshTok);
        if (newTok) {
          tokenStatus = 'refreshed_cold';
          const orders = await fetchOrders(locationId, newTok) || [];
          const sorted = [...orders].sort((a, b) => ((b._id || '') > (a._id || '') ? 1 : -1));
          const calOrder = sorted.find(o => o.sourceType === 'calendar' || (o.source && o.source.type === 'calendar')) || sorted[0];
          const orderId  = calOrder ? (calOrder._id || '') : '';
          if (orderId) {
            try {
              const pr = await fetchWithTimeout('https://backend.leadconnectorhq.com/payments/orders/public/' + orderId, {}, 2000);
              if (pr.ok) {
                const pd     = await pr.json();
                const depAmt = (pd.paymentSummary && pd.paymentSummary.initialAmount > 0) ? pd.paymentSummary.initialAmount : 0;
                const totalAmt = pd.amount || 0;
                srvDepAmt    = depAmt || totalAmt;
                srvFullAmt   = (totalAmt > srvDepAmt && srvDepAmt > 0) ? totalAmt : 0;
                srvOrderCur  = (pd.currency || 'JMD').toUpperCase();
                srvOrderDesc = (pd.source && pd.source.name) || 'Booking Deposit';
                srvOrderId   = orderId;
                console.log('[pay] ✅ dep (cold):', srvDepAmt, 'full:', srvFullAmt);
              }
            } catch (pe) {}
          }
        }
      }
    } catch (e) {
      tokenStatus = 'db_error';
      console.error('[pay] db error:', e.message);
    }
  }

  console.log('[pay] final dep:', srvDepAmt, 'full:', srvFullAmt, 'status:', tokenStatus);

  // Template variables for client JS
  const L        = JSON.stringify(locationId);
  const URL_AMT  = JSON.stringify(urlAmount);
  const URL_CUR  = JSON.stringify(urlCurrency);
  const URL_TXN  = JSON.stringify(urlTxId);
  const SRV_DEP  = JSON.stringify(srvDepAmt);
  const SRV_FULL = JSON.stringify(srvFullAmt);
  const SRV_CUR  = JSON.stringify(srvOrderCur);
  const SRV_DESC = JSON.stringify(srvOrderDesc);
  const SRV_ORD  = JSON.stringify(srvOrderId);

  const clientJS = `
var L=${L},URL_AMT=${URL_AMT},URL_CUR=${URL_CUR},URL_TXN=${URL_TXN};
var SRV_DEP=${SRV_DEP},SRV_FULL=${SRV_FULL},SRV_CUR=${SRV_CUR},SRV_DESC=${SRV_DESC},SRV_ORD=${SRV_ORD};
var done=false,confirmed=false,SID='',poll=null,DEP_AMT=0,FULL_AMT=0,CUR='JMD',DESC='Deposit',INV='';
window._GHL_TXN='';

function $el(id){return document.getElementById(id);}
function ss(t){var el=$el('st');if(el)el.textContent=t;}

function fmt(amt,cur){
  var sym=(cur==='USD')?'US$':'J$';
  return sym+Math.round(amt).toLocaleString();
}

function applyAmts(dep,full,cur,desc,ord){
  if(done)return;
  DEP_AMT=parseFloat(dep)||0;FULL_AMT=parseFloat(full)||0;
  CUR=cur||'JMD';DESC=desc||'Deposit';INV=ord||'';window._GHL_TXN=ord||'';
  if(!DEP_AMT)return;

  $el('svc').textContent=DESC;

  if(FULL_AMT>DEP_AMT){
    // Two-card layout: Deposit vs Full
    $el('dep-amt').textContent=fmt(DEP_AMT,CUR);
    $el('full-amt').textContent=fmt(FULL_AMT,CUR);
    $el('opts').style.display='flex';
    $el('single').style.display='none';
    ss('Choose how much to pay to secure your booking');
  } else {
    // Single button (fixed deposit mode)
    $el('single-amt').textContent=fmt(DEP_AMT,CUR);
    $el('single').style.display='block';
    $el('opts').style.display='none';
    ss('Tap to secure your booking');
  }
}

function confirmPayment(){
  if(confirmed)return;confirmed=true;clearInterval(poll);
  ss('\u2705 Payment confirmed! Your booking is secured.');
  var cid=window._GHL_TXN||SID;
  window.parent.postMessage(JSON.stringify({type:'custom_element_success_response',chargeId:cid}),'*');
  window.parent.postMessage({type:'custom_element_success_response',chargeId:cid},'*');
  setTimeout(function(){
    window.parent.postMessage(JSON.stringify({type:'custom_element_close_response'}),'*');
    window.parent.postMessage({type:'custom_element_close_response'},'*');
  },1500);
}

function openHP(choice){
  if(done)return;
  var amt=(choice==='full'&&FULL_AMT>0)?FULL_AMT:DEP_AMT;
  if(!amt)return;
  done=true;

  // iOS Safari fix: open blank tab SYNCHRONOUSLY in the user gesture handler.
  // window.open() is allowed on iOS only when called from a direct user click.
  // We open an empty tab immediately, then navigate it to HandyPay once we have
  // the checkoutUrl from the server. This pattern works on all browsers.
  var w=window.open('','_blank');

  // Disable all buttons while creating session
  ['btn-dep','btn-full','btn-single'].forEach(function(id){
    var el=$el(id);if(el)el.disabled=true;
  });
  ss('Opening HandyPay...');

  fetch('/api/create-native-session',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      locationId:L,
      amountJMD:amt,
      currency:CUR,
      description:DESC,
      entityId:INV,
      ghlTransactionId:window._GHL_TXN||'',
      paymentType:'calendar',
      paymentChoice:choice
    })
  }).then(function(r){return r.json();})
  .then(function(d){
    if(!d.checkoutUrl){
      // Session creation failed
      if(w)try{w.close();}catch(e){}
      ss('Error: '+(d.error||'Could not create checkout. Please try again.'));
      window.parent.postMessage(JSON.stringify({type:'custom_element_error_response',error:{description:d.error||'Payment error'}}),'*');
      ['btn-dep','btn-full','btn-single'].forEach(function(id){var el=$el(id);if(el)el.disabled=false;});
      done=false;return;
    }
    SID=d.sessionId||d.paymentIntentId||'';

    if(w&&!w.closed){
      // Navigate the pre-opened blank tab to HandyPay (iOS Safari pattern)
      w.location.href=d.checkoutUrl;
    } else {
      // Blank tab was blocked or closed — try opening directly
      w=window.open(d.checkoutUrl,'_blank');
      if(!w){
        ss('\u26a0 Please allow popups for this site, then tap the button again.');
        ['btn-dep','btn-full','btn-single'].forEach(function(id){var el=$el(id);if(el)el.disabled=false;});
        done=false;return;
      }
    }

    ss('\u23f3 Complete payment in the HandyPay tab, then return here.');

    // Poll every 3s for payment completion
    poll=setInterval(function(){
      if(!SID)return;
      fetch('/api/query?paymentIntentId='+SID)
        .then(function(r){return r.json();})
        .then(function(qd){
          if(qd.success===true)confirmPayment();
          else if(qd.failed===true){
            clearInterval(poll);
            ss('Payment was not completed. Please try again.');
            ['btn-dep','btn-full','btn-single'].forEach(function(id){var el=$el(id);if(el)el.disabled=false;});
            done=false;
          }
        }).catch(function(){});
    },3000);
  }).catch(function(e){
    if(w)try{w.close();}catch(ex){}
    ss('Connection error. Please try again.');
    ['btn-dep','btn-full','btn-single'].forEach(function(id){var el=$el(id);if(el)el.disabled=false;});
    done=false;
  });
}

(function init(){
  window.parent.postMessage(JSON.stringify({type:'custom_element_loaded'}),'*');
  window.parent.postMessage({type:'custom_element_loaded'},'*');
  if(SRV_DEP>0){
    // Delay 800ms to let GHL finish its own init before we modify the iframe
    setTimeout(function(){if(!done&&DEP_AMT===0)applyAmts(SRV_DEP,SRV_FULL,SRV_CUR,SRV_DESC,SRV_ORD);},800);
  }
  // URL param fallback (invoice flow)
  if(URL_AMT>0)applyAmts(URL_AMT,0,URL_CUR,'',URL_TXN);
})();

// postMessage listener: GHL payment_initiate_props (invoice/order form flow)
window.addEventListener('message',function(e){
  var data;try{data=typeof e.data==='object'?e.data:JSON.parse(e.data);}catch(x){return;}
  if(!data)return;
  var t=data.type||'';
  if(t==='PAYMENT_SUCCESS'){confirmPayment();return;}
  if(t==='payment_initiate_props'){
    var pAmt=parseFloat(data.amount||data.amountJMD||0);
    // GHL sends amount in cents for some flows — normalise if >= 100000
    if(pAmt>0)applyAmts(
      pAmt>=100000?Math.round(pAmt/100):pAmt,
      0,
      data.currency||'JMD',
      data.description||data.name||'',
      data.entityId||data.orderId||''
    );
  }
});
`;

  const css = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8faff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:16px}
.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:440px;width:100%;padding:28px;text-align:center}
.logo{font-size:36px;margin-bottom:6px}
.brand{font-size:17px;font-weight:800;color:#1a1a1a;margin-bottom:4px}
.svc{font-size:13px;color:#666;margin-bottom:20px;min-height:16px;line-height:1.4}
/* Two-option layout */
.opts{display:none;gap:10px;margin-bottom:16px}
.opt-btn{flex:1;background:#fff;border:2px solid #e2e8f0;border-radius:12px;padding:14px 8px;cursor:pointer;transition:border-color .15s,background .15s;text-align:center;font-family:inherit}
.opt-btn:hover:not(:disabled){border-color:#15803d;background:#f0fdf4}
.opt-btn:disabled{opacity:.5;cursor:not-allowed}
.opt-label{font-size:11px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px}
.opt-amt{font-size:20px;font-weight:800;color:#15803d;margin-bottom:3px}
.opt-sub{font-size:11px;color:#888}
/* Single button layout */
.single{display:none;margin-bottom:16px}
.single-amt{font-size:28px;font-weight:800;color:#15803d;margin-bottom:14px}
.btn{background:#15803d;color:#fff;border:none;border-radius:10px;padding:13px 24px;font-size:15px;font-weight:700;cursor:pointer;width:100%;font-family:inherit}
.btn:disabled{opacity:.6;cursor:not-allowed}
/* Status text */
.st{font-size:13px;color:#555;margin-top:10px;min-height:18px;line-height:1.5}
`;

  const html = `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandyPay</title>
<style>${css}</style>
</head><body><div class="card">
<div class="logo">&#x1F4B3;</div>
<div class="brand">HandyPay</div>
<div class="svc" id="svc">Loading payment details...</div>
<div class="opts" id="opts">
  <button class="opt-btn" id="btn-dep" onclick="openHP('deposit')">
    <div class="opt-label">Pay Deposit</div>
    <div class="opt-amt" id="dep-amt"></div>
    <div class="opt-sub">Secures your spot</div>
  </button>
  <button class="opt-btn" id="btn-full" onclick="openHP('full')">
    <div class="opt-label">Pay in Full</div>
    <div class="opt-amt" id="full-amt"></div>
    <div class="opt-sub">Nothing owed later</div>
  </button>
</div>
<div class="single" id="single">
  <div class="single-amt" id="single-amt"></div>
  <button class="btn" id="btn-single" onclick="openHP('deposit')">Open HandyPay Checkout</button>
</div>
<div class="st" id="st"></div>
</div>
<script>${clientJS}<\/script></body></html>`;

  res.end(html);
};
