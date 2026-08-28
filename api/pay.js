// api/pay.js — GHL Custom Payment Provider iframe
// v4: Concurrent-booking safe
//
// KEY FINDINGS (preserved from v3):
//   - GHL calendar NEVER sends payment_initiate_props postMessage
//   - Server-side order fetch is the only viable approach
//   - GHL iframe sandbox="" (no restrictions), allow="payment"
//   - window.open() must fire from direct user click (not setTimeout)
//   - Sort orders by _id DESC (MongoDB ObjectID = newest first)
//
// v4 CHANGES:
//   - FAST PATH: if GHL passes orderId/paymentIntentId in URL, fetch that specific
//     order directly (no token needed — public endpoint) BEFORE the latest-order lookup.
//     Eliminates the "latest order" race condition when multiple customers book
//     the same service simultaneously.
//   - Pool config: max:3 (up from 2) to handle modest concurrency
'use strict';

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
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
      console.log('[pay] token refreshed');
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

// Shared helper: parse a GHL public order object into {depAmt, fullAmt, cur, desc}
function parseOrderAmounts(pd) {
  const depAmt   = (pd.paymentSummary && pd.paymentSummary.initialAmount > 0) ? pd.paymentSummary.initialAmount : 0;
  const totalAmt = pd.amount || 0;
  return {
    depAmt:  depAmt || totalAmt,
    fullAmt: (totalAmt > (depAmt || totalAmt) && (depAmt || totalAmt) > 0) ? totalAmt : 0,
    cur:     (pd.currency || 'JMD').toUpperCase(),
    desc:    (pd.source && pd.source.name) || 'Booking Deposit'
  };
}

// Extracts the creation timestamp (ms) encoded in a MongoDB ObjectID's first 4 bytes.
// Used to prioritise very recent orders (invoice just triggered) over older calendar ones.
function objectIdTimestampMs(id) {
  if (!id || typeof id !== 'string' || id.length < 8) return 0;
  try { return parseInt(id.substring(0, 8), 16) * 1000; } catch (e) { return 0; }
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

  let srvOrderId = '', srvDepAmt = 0, srvFullAmt = 0, srvOrderCur = 'JMD', srvOrderDesc = '';
  let tokenStatus = 'no_location';

  // ── FAST PATH: direct order fetch by URL-supplied order ID ────────────────────────────
  if (urlTxId) {
    try {
      const pr = await fetchWithTimeout(
        'https://backend.leadconnectorhq.com/payments/orders/public/' + urlTxId, {}, 2000
      );
      if (pr.ok) {
        const pd = await pr.json();
        const { depAmt, fullAmt, cur, desc } = parseOrderAmounts(pd);
        srvDepAmt    = depAmt;
        srvFullAmt   = fullAmt;
        srvOrderCur  = cur;
        srvOrderDesc = desc;
        srvOrderId   = urlTxId;
        tokenStatus  = 'url_direct';
        console.log('[pay] url-direct dep:', srvDepAmt, 'full:', srvFullAmt, cur, 'id:', urlTxId);
      }
    } catch(e) {
      console.warn('[pay] url-direct failed, falling back to order list:', e.message);
    }
  }

  // ── FALLBACK: fetch latest order via CRM token ────────────────────────────────────────
  // Used when GHL does not include the order ID in the URL (calendar flow).
  // Fetches the 5 most recent unpaid orders for this location and picks the
  // newest one (using MongoDB ObjectID timestamp for recency — prefers orders
  // created in the last 5 min, covering invoice payment context).
  if (locationId && !srvOrderId) {
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

        const sorted = Array.isArray(orders)
          ? [...orders].sort((a, b) => ((b._id || '') > (a._id || '') ? 1 : -1))
          : [];
        // Prefer the most-recent order created in the last 5 min (covers invoice context);
        // fall back to the most-recent calendar order, then any order.
        const _now1 = Date.now(), _5m = 5 * 60 * 1000;
        const recentAny1 = sorted.find(o => (_now1 - objectIdTimestampMs(o._id)) < _5m);
        const calOrder = recentAny1
          || sorted.find(o => o.sourceType === 'calendar' || (o.source && o.source.type === 'calendar'))
          || sorted[0] || null;
        const orderId  = calOrder ? (calOrder._id || '') : '';

        if (orderId) {
          try {
            const pr = await fetchWithTimeout('https://backend.leadconnectorhq.com/payments/orders/public/' + orderId, {}, 2000);
            if (pr.ok) {
              const pd = await pr.json();
              const { depAmt, fullAmt, cur, desc } = parseOrderAmounts(pd);
              srvDepAmt    = depAmt;
              srvFullAmt   = fullAmt;
              srvOrderCur  = cur;
              srvOrderDesc = desc;
              srvOrderId   = orderId;
              console.log('[pay] dep:', srvDepAmt, 'full:', srvFullAmt, srvOrderCur, 'orderId:', orderId);
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
          const _now2 = Date.now();
          const recentAny2 = sorted.find(o => (Date.now() - objectIdTimestampMs(o._id)) < 5 * 60 * 1000);
          const calOrder = recentAny2
            || sorted.find(o => o.sourceType === 'calendar' || (o.source && o.source.type === 'calendar'))
            || sorted[0];
          const orderId  = calOrder ? (calOrder._id || '') : '';
          if (orderId) {
            try {
              const pr = await fetchWithTimeout('https://backend.leadconnectorhq.com/payments/orders/public/' + orderId, {}, 2000);
              if (pr.ok) {
                const pd = await pr.json();
                const { depAmt, fullAmt, cur, desc } = parseOrderAmounts(pd);
                srvDepAmt    = depAmt;
                srvFullAmt   = fullAmt;
                srvOrderCur  = cur;
                srvOrderDesc = desc;
                srvOrderId   = orderId;
                console.log('[pay] dep (cold):', srvDepAmt, 'full:', srvFullAmt);
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
    $el('dep-amt').textContent=fmt(DEP_AMT,CUR);
    $el('full-amt').textContent=fmt(FULL_AMT,CUR);
    $el('opts').style.display='flex';
    $el('single').style.display='none';
    ss('Choose how much to pay to secure your booking');
  } else {
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

  var w=window.open('','_blank');

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
      if(w)try{w.close();}catch(e){}
      ss('Error: '+(d.error||'Could not create checkout. Please try again.'));
      window.parent.postMessage(JSON.stringify({type:'custom_element_error_response',error:{description:d.error||'Payment error'}}),'*');
      ['btn-dep','btn-full','btn-single'].forEach(function(id){var el=$el(id);if(el)el.disabled=false;});
      done=false;return;
    }
    SID=d.sessionId||d.paymentIntentId||'';

    if(w&&!w.closed){
      w.location.href=d.checkoutUrl;
    } else {
      w=window.open(d.checkoutUrl,'_blank');
      if(!w){
        ss('\u26a0 Please allow popups for this site, then tap the button again.');
        ['btn-dep','btn-full','btn-single'].forEach(function(id){var el=$el(id);if(el)el.disabled=false;});
        done=false;return;
      }
    }

    ss('\u23f3 Complete payment in the HandyPay tab, then return here.');

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

// Initialise with server-rendered amounts
applyAmts(SRV_DEP,SRV_FULL,SRV_CUR,SRV_DESC,SRV_ORD);

// Listen for GHL postMessage (payment_initiate_props) as a secondary source
window.addEventListener('message',function(ev){
  var d=ev.data;
  if(typeof d==='string'){try{d=JSON.parse(d);}catch(e){return;}}
  if(!d||typeof d!=='object')return;
  var t=d.type||d.event||'';
  if(t==='payment_initiate_props'||t==='paymentInitiateProps'){
    var o=d.data||d.payload||d||{};
    var amt=parseFloat(o.amount||o.amountJMD||o.totalAmount||'0')||0;
    var cur=(o.currency||'JMD').toUpperCase();
    var txId=o.orderId||o.paymentIntentId||o.transactionId||o.entityId||'';
    if(amt>0)applyAmts(amt,0,cur,o.description||DESC,txId||INV);
  }
});
`;

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>HandyPay</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;}
.card{background:#fff;border-radius:16px;padding:32px 28px;width:100%;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center;}
.logo{width:48px;height:32px;margin-bottom:12px;}
.brand{font-size:20px;font-weight:700;color:#1a1a2e;margin-bottom:6px;}
.svc{font-size:14px;color:#666;margin-bottom:24px;}
.opts{display:none;gap:12px;margin-bottom:16px;}
.opt{flex:1;border:2px solid #e5e7eb;border-radius:12px;padding:16px 12px;cursor:pointer;transition:.15s;background:#fff;}
.opt:hover{border-color:#4f46e5;background:#f5f3ff;}
.opt-label{font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;}
.opt-amt{font-size:22px;font-weight:800;color:#4f46e5;}
.opt-sub{font-size:11px;color:#aaa;margin-top:4px;}
.single{display:none;margin-bottom:16px;}
.btn-single{width:100%;padding:16px;background:#4f46e5;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;}
.btn-single:hover{background:#4338ca;}
.st{font-size:13px;color:#888;min-height:20px;}
</style>
</head><body>
<div class="card">
<img class="logo" src="https://storage.googleapis.com/crm-conversations-ai-production/ask-ai-images/1785549533996/aaf88bbe-7f89-44b6-ba1b-12a6417755f6.png" alt="HandyPay"/>
<div class="brand">HandyPay</div>
<div class="svc" id="svc">Loading...</div>
<div class="opts" id="opts" style="display:flex">
<div class="opt" id="btn-dep" onclick="openHP('deposit')">
  <div class="opt-label">PAY DEPOSIT</div>
  <div class="opt-amt" id="dep-amt">...</div>
  <div class="opt-sub">Secures your spot</div>
</div>
<div class="opt" id="btn-full" onclick="openHP('full')">
  <div class="opt-label">PAY IN FULL</div>
  <div class="opt-amt" id="full-amt">...</div>
  <div class="opt-sub">Nothing owed later</div>
</div>
</div>
<div class="single" id="single">
  <button class="btn-single" id="btn-single" onclick="openHP('deposit')">Open HandyPay Checkout</button>
</div>
<div class="st" id="st"></div>
</div>
<script>${clientJS}<\/script></body></html>`;

  res.end(html);
};
