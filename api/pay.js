// api/pay.js — GHL Custom Payment Provider iframe
//
// CALENDAR FIX: Three-channel approach for getting payment amount:
//   1. Send {type:'custom_element_loaded'} ready signal — GHL may wait for this
//   2. Check window.name (GHL may encode orderId/amount there)
//   3. Check location.hash (GHL may encode orderId there)
//   4. Wait for payment_initiate_props postMessage (handles both string + object)
//   5. If orderId found via any channel, fetch /api/ghl-order to get amount
// confirmPayment sends both string and object, covers all GHL surfaces.
'use strict';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const q = req.query || {};
  const locationId   = q.locationId || '';
  const urlAmount    = parseFloat(q.amount || q.amountJMD || '0') || 0;
  const urlCurrency  = (q.currency || 'JMD').toUpperCase();
  const urlTxId      = q.paymentIntentId || q.transactionId || q.orderId || q.entityId || '';

  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Type', 'text/html');

  const L        = JSON.stringify(locationId);
  const URL_AMT  = JSON.stringify(urlAmount);
  const URL_CUR  = JSON.stringify(urlCurrency);
  const URL_TXN  = JSON.stringify(urlTxId);

  const html = '<!DOCTYPE html><html><head>'
    + '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandyPay</title>'
    + '<style>'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f8faff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px}'
    + '.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;width:100%;padding:40px;text-align:center}'
    + '.logo{font-size:48px;margin-bottom:8px}'
    + 'h2{font-size:20px;font-weight:800;color:#1a1a1a;margin-bottom:16px}'
    + '.amt{font-size:32px;font-weight:800;color:#15803d;margin-bottom:8px;display:none}'
    + '.lbl{font-size:14px;color:#666;margin-bottom:24px}'
    + '.btn{background:#15803d;color:#fff;border:none;border-radius:10px;padding:14px 28px;font-size:16px;font-weight:700;cursor:pointer;width:100%;display:none;margin-bottom:8px}'
    + '.btn:disabled{opacity:.6;cursor:not-allowed}'
    + '.st{font-size:14px;color:#555;margin-top:16px;min-height:20px}'
    + '#dbg{margin-top:16px;padding:8px;background:#f1f5f9;border-radius:8px;font-size:10px;font-family:monospace;color:#555;text-align:left;word-break:break-all;line-height:1.5}'
    + '</style></head><body>'
    + '<div class="card">'
    + '<div class="logo">&#x1F4B3;</div><h2>HandyPay</h2>'
    + '<div class="amt" id="a"></div>'
    + '<div class="lbl" id="l">Loading payment details...</div>'
    + '<button class="btn" id="b" onclick="openHP()">Open HandyPay Checkout</button>'
    + '<div class="st" id="s"></div>'
    + '<div id="dbg">Initialising...</div>'
    + '</div>'
    + '<script>'
    + 'var L='+L+',URL_AMT='+URL_AMT+',URL_CUR='+URL_CUR+',URL_TXN='+URL_TXN+';'
    + 'var done=false,confirmed=false,SID="",poll=null,AMT=0,DESC="Deposit",INV="";'
    + 'window._GHL_TXN="";'
    + 'var dbgLines=[];'
    + 'function $el(id){return document.getElementById(id);}'
    + 'function ss(t){$el("s").textContent=t;}'
    + 'function dbg(){$el("dbg").innerHTML=dbgLines.slice(-12).join("<br>");}'
    + 'function dlog(s){dbgLines.push(s);dbg();'
    + 'try{fetch("/api/debug-log",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({label:"pay",data:s})}).catch(function(){});}catch(e){}}'
    // JMD helper
    + 'function jmd(raw,cur){var n=parseFloat(raw)||0;if(!n)return 0;cur=(cur||"").toUpperCase();if(cur==="USD")return Math.round((n>=100?n/100:n)*155);return n>=10000?Math.round(n/100):n;}'
    // Show amount + auto-trigger
    + 'function applyAmt(amt,cur,desc,txn,ord){'
    + 'if(done)return;'
    + 'AMT=jmd(amt,cur);if(!AMT)return;'
    + 'DESC=desc||"Deposit";INV=ord||txn||"";window._GHL_TXN=txn||ord||"";'
    + 'dlog("\u2714 Amount: J$"+Math.round(AMT)+" ["+DESC+"]");'
    + '$el("a").textContent="J$"+Math.round(AMT).toLocaleString();$el("a").style.display="block";'
    + '$el("l").textContent=DESC;$el("b").style.display="block";'
    + 'setTimeout(openHP,500);}'
    // Fetch GHL public order for amount
    + 'function fetchOrder(ordId){'
    + 'if(!ordId)return;dlog("\U0001f50e Fetching order: "+ordId.substring(0,12)+"...");'
    + 'fetch("/api/ghl-order?orderId="+encodeURIComponent(ordId))'
    + '.then(function(r){return r.json();})'
    + '.then(function(d){if(d.amount>0)applyAmt(d.amount,d.currency,d.description,d.transactionId,d.orderId);else dlog("\u26a0\ufe0f order fetch: amt=0");})'
    + '.catch(function(e){dlog("\u274c order fetch error: "+e.message);});'
    + '}'
    // confirmPayment
    + 'function confirmPayment(){'
    + 'if(confirmed)return;confirmed=true;clearInterval(poll);'
    + 'dlog("\u2705 Confirmed! Notifying GHL...");ss("\u2705 Payment confirmed!");'
    + 'var cid=window._GHL_TXN||SID;'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_success_response",chargeId:cid}),"*");'
    + 'window.parent.postMessage({type:"custom_element_success_response",chargeId:cid},"*");'
    + 'setTimeout(function(){'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_close_response"}),"*");'
    + 'window.parent.postMessage({type:"custom_element_close_response"},"*");'
    + '},1500);}'
    // openHP
    + 'function openHP(){'
    + 'if(done)return;done=true;$el("b").disabled=true;ss("Opening HandyPay...");'
    + 'dlog("\U0001f680 Creating session: J$"+Math.round(AMT));'
    + 'fetch("/api/create-native-session",{method:"POST",headers:{"Content-Type":"application/json"},'
    + 'body:JSON.stringify({locationId:L,amountJMD:AMT,description:DESC,entityId:INV,ghlTransactionId:window._GHL_TXN||"",paymentType:"calendar"})})'
    + '.then(function(r){return r.json();})'
    + '.then(function(d){'
    + 'if(!d.checkoutUrl){dlog("\u274c No checkoutUrl: "+(d.error||"?"));ss("Error: "+(d.error||"No checkout URL"));'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_error_response",error:{description:d.error||"Session error"}}),"*");'
    + '$el("b").disabled=false;done=false;return;}'
    + 'SID=d.sessionId||d.paymentIntentId||"";dlog("\u23f3 Session: "+SID.substring(0,12)+"...");'
    + 'var w=window.open(d.checkoutUrl,"_blank");'
    + 'if(!w){ss("Popup blocked \u2014 allow popups and retry");$el("b").disabled=false;done=false;return;}'
    + 'ss("\u23f3 HandyPay open in new tab. Return here after paying.");'
    + 'poll=setInterval(function(){if(!SID)return;'
    + 'fetch("/api/query?paymentIntentId="+SID).then(function(r){return r.json();}).then(function(qd){'
    + 'if(qd.success===true)confirmPayment();'
    + 'else if(qd.failed===true){clearInterval(poll);ss("Payment failed. Try again.");done=false;$el("b").disabled=false;}'
    + '}).catch(function(){});},3000);})
    + '.catch(function(e){dlog("\u274c session error: "+e.message);ss("Error: "+e.message);$el("b").disabled=false;done=false;});'
    + '}'
    // INIT
    + '(function init(){'
    // 1. Send ready signal — GHL waits for this before sending payment_initiate_props
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_loaded"}),"*");'
    + 'window.parent.postMessage({type:"custom_element_loaded"},"*");'
    // 2. Detect frame type
    + 'var inIframe=(window!==window.top);'
    + 'dlog((inIframe?"\u2705 iframe":"\u26a0\ufe0f standalone")+" | "+location.search);'
    // 3. Check window.name
    + 'var winName="";try{winName=window.name||"";dlog("window.name: "+(winName?winName.substring(0,60):"(empty)"));}catch(e){}'
    + 'if(winName){'
    + 'var nd=null;try{nd=JSON.parse(winName);}catch(e){}'
    + 'if(nd&&nd.orderId)fetchOrder(nd.orderId);'
    + 'else if(nd&&(nd.amount||nd.amountJMD))applyAmt(nd.amount||nd.amountJMD,nd.currency,nd.description,nd.transactionId||nd.paymentIntentId,nd.orderId||nd.entityId);'
    + 'else if(!nd&&winName.length>=20&&winName.length<=30)fetchOrder(winName);'
    + '}'
    // 4. Check location.hash
    + 'var hash=location.hash;'
    + 'dlog("hash: "+(hash||"(none)"));'
    + 'if(hash&&hash.length>1){'
    + 'try{var hp=new URLSearchParams(hash.substring(1));'
    + 'var hOrd=hp.get("orderId")||hp.get("order_id")||"";'
    + 'var hAmt=parseFloat(hp.get("amount")||"0");'
    + 'if(hOrd)fetchOrder(hOrd);else if(hAmt>0)applyAmt(hAmt,hp.get("currency"),hp.get("description"),hp.get("transactionId")||"","");'
    + '}catch(e){}}'
    // 5. URL params from server
    + 'if(URL_AMT>0)applyAmt(URL_AMT,URL_CUR,"",URL_TXN,URL_TXN);'
    // 6. Timeout warning
    + 'setTimeout(function(){if(!done&&AMT===0)dlog("\u26a0\ufe0f 8s: still no amount \u2014 check GHL provider config");},8000);'
    + '})();'
    // MESSAGE LISTENER
    + 'window.addEventListener("message",function(e){'
    + 'var data;try{data=typeof e.data==="object"?e.data:JSON.parse(e.data);}catch(x){return;}'
    + 'if(!data)return;'
    + 'var t=data.type||"";'
    + 'dlog("\U0001f4e8 msg: "+t+" origin:"+e.origin.substring(0,30));'
    + 'if(t==="PAYMENT_SUCCESS"){confirmPayment();return;}'
    + 'if(t==="payment_initiate_props"){'
    + 'dlog("\u2728 payment_initiate_props! amt="+(data.amount||data.amountJMD||"?"));'
    + 'var pAmt=data.amount||data.amountJMD||0;'
    + 'var pOrd=data.entityId||data.invoiceId||data.orderId||"";'
    + 'var pTxn=data.transactionId||data.paymentIntentId||"";'
    + 'if(!pAmt&&pOrd)fetchOrder(pOrd);'
    + 'else applyAmt(pAmt,data.currency,data.description||data.name,pTxn,pOrd);'
    + '}'
    + '});'
    + '<\/script></body></html>';

  res.end(html);
};
