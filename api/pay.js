// api/pay.js — GHL Custom Payment Provider iframe
//
// DIAGNOSTIC BUILD: captures ALL postMessages + URL params + iframe-vs-standalone
// into Neon via /api/debug-log so we can see exactly what GHL sends for calendar bookings.
//
// Handles BOTH modes:
//   iframe mode    — GHL embeds us, sends payment_initiate_props via postMessage
//   standalone mode — GHL redirects customer here; reads amount from URL params
//
// confirmPayment() sends postMessage for iframe mode;
// standalone mode relies on GHL polling /api/query for status.
'use strict';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const q            = req.query || {};
  const locationId   = q.locationId   || '';
  // URL params GHL might pass (calendar redirect mode)
  const urlAmount    = parseFloat(q.amount || q.amountJMD || '0') || 0;
  const urlCurrency  = (q.currency  || 'JMD').toUpperCase();
  const urlTxId      = q.paymentIntentId || q.transactionId || q.entityId || '';
  const urlDesc      = q.description || q.name || '';

  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Type', 'text/html');

  // Embed server-side known values into the page
  const L         = JSON.stringify(locationId);
  const URL_AMT   = JSON.stringify(urlAmount);
  const URL_CUR   = JSON.stringify(urlCurrency);
  const URL_TXN   = JSON.stringify(urlTxId);
  const URL_DESC  = JSON.stringify(urlDesc);
  const FULL_URL  = JSON.stringify(req.url || '');

  const html = '<!DOCTYPE html><html><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>HandyPay</title>'
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
    // Debug panel
    + '#dbg{margin-top:20px;padding:10px;background:#f1f5f9;border-radius:8px;text-align:left;font-size:11px;font-family:monospace;color:#444;line-height:1.5;word-break:break-all}'
    + '</style>'
    + '</head><body>'
    + '<div class="card">'
    + '<div class="logo">&#x1F4B3;</div>'
    + '<h2>HandyPay</h2>'
    + '<div class="amt" id="a"></div>'
    + '<div class="lbl" id="l">Loading payment details...</div>'
    + '<button class="btn" id="b" onclick="openHP()">Open HandyPay Checkout</button>'
    + '<div class="st" id="s"></div>'
    + '<div id="dbg">\u26a1 Debug mode | loading...</div>'
    + '</div>'
    + '<script>'
    // Server-injected values
    + 'var L=' + L + ';'
    + 'var URL_AMT=' + URL_AMT + ';'
    + 'var URL_CUR=' + URL_CUR + ';'
    + 'var URL_TXN=' + URL_TXN + ';'
    + 'var URL_DESC=' + URL_DESC + ';'
    + 'var FULL_URL=' + FULL_URL + ';'
    // State
    + 'var done=false,confirmed=false,SID="",poll=null,AMT=0,DESC="Payment",INV="";'
    + 'var msgLog=[];'
    // Helpers
    + 'function ss(t){document.getElementById("s").textContent=t;}'
    + 'function dbgUpdate(){document.getElementById("dbg").innerHTML=msgLog.join("<br>");}'
    + 'function jmd(raw,cur){'
    + 'var n=parseFloat(raw)||0;if(!n)return 0;'
    + 'cur=(cur||"").toUpperCase();'
    + 'if(cur==="USD")return Math.round((n>=100?n/100:n)*155);'
    + 'return n>=10000?Math.round(n/100):n;}'
    // Log to Neon via /api/debug-log
    + 'function dbgLog(label,data){'
    + 'try{fetch("/api/debug-log",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({label:label,data:data})}).catch(function(){});}'
    + 'catch(e){}'
    + '}'
    // confirmPayment
    + 'function confirmPayment(){'
    + 'if(confirmed)return;confirmed=true;clearInterval(poll);'
    + 'ss("\u2705 Payment confirmed!");'
    + 'dbgLog("confirm",{SID:SID,txn:window._GHL_TXN});'
    + 'msgLog.push("\u2705 CONFIRMED — posting success to GHL");dbgUpdate();'
    + 'var cid=window._GHL_TXN||SID;'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_success_response",chargeId:cid}),"*");'
    + 'window.parent.postMessage({type:"custom_element_success_response",chargeId:cid},"*");'
    + 'setTimeout(function(){'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_close_response"}),"*");'
    + 'window.parent.postMessage({type:"custom_element_close_response"},"*");'
    + '},1500);}'
    // openHP
    + 'function openHP(){'
    + 'if(done)return;done=true;'
    + 'document.getElementById("b").disabled=true;ss("Opening HandyPay...");'
    + 'dbgLog("openHP",{AMT:AMT,INV:INV,txn:window._GHL_TXN});'
    + 'fetch("/api/create-native-session",{method:"POST",headers:{"Content-Type":"application/json"},'
    + 'body:JSON.stringify({locationId:L,amountJMD:AMT,description:DESC,entityId:INV,ghlTransactionId:window._GHL_TXN||""})})'
    + '.then(function(r){return r.json();})'
    + '.then(function(d){'
    + 'if(!d.checkoutUrl){'
    + 'ss("Error: "+(d.error||"No checkout URL"));'
    + 'msgLog.push("\u274c Session error: "+(d.error||"?"));dbgUpdate();'
    + 'dbgLog("session_error",{error:d.error});'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_error_response",error:{description:d.error||"Session creation failed"}}),"*");'
    + 'document.getElementById("b").disabled=false;done=false;return;}'
    + 'SID=d.sessionId||d.paymentIntentId||"";'
    + 'msgLog.push("\u23f3 Checkout opened. Polling every 3s...");dbgUpdate();'
    + 'dbgLog("session_created",{SID:SID,url:d.checkoutUrl});'
    + 'var w=window.open(d.checkoutUrl,"_blank");'
    + 'if(!w){ss("Popup blocked \u2014 allow popups and retry");document.getElementById("b").disabled=false;done=false;return;}'
    + 'ss("\u23f3 HandyPay open in new tab. Return here after paying.");'
    + 'poll=setInterval(function(){'
    + 'if(!SID)return;'
    + 'fetch("/api/query?paymentIntentId="+SID)'
    + '.then(function(r){return r.json();})'
    + '.then(function(qd){'
    + 'if(qd.success===true){confirmPayment();}'
    + 'else if(qd.failed===true){clearInterval(poll);ss("Payment failed. Try again.");done=false;document.getElementById("b").disabled=false;}'
    + '}).catch(function(){});'
    + '},3000);'
    + '})'
    + '.catch(function(e){ss("Error: "+e.message);document.getElementById("b").disabled=false;done=false;});'
    + '}'
    // Initialise: detect frame + URL params
    + '(function init(){'
    + 'var inIframe=(window!==window.top);'
    + 'var params=location.search;'
    + 'dbgLog("pay_load",{inIframe:inIframe,params:params,urlAmt:URL_AMT,urlTxn:URL_TXN,fullUrl:FULL_URL});'
    + 'msgLog.push("\u1f4cd Frame: "+(inIframe?"\u2705 in iframe":"\u26a0\ufe0f STANDALONE — no parent frame"));'
    + 'msgLog.push("\U0001f517 URL params: "+(params||("[none]")));'
    // If GHL passed amount in URL (calendar redirect mode)
    + 'if(URL_AMT>0){'
    + 'AMT=jmd(URL_AMT,URL_CUR);'
    + 'DESC=URL_DESC||"Payment";'
    + 'window._GHL_TXN=URL_TXN;'
    + 'INV=URL_TXN;'
    + 'document.getElementById("a").textContent="J$"+Math.round(AMT).toLocaleString();'
    + 'document.getElementById("a").style.display="block";'
    + 'document.getElementById("l").textContent=DESC;'
    + 'document.getElementById("b").style.display="block";'
    + 'msgLog.push("\U0001f4b5 URL amount found: J$"+Math.round(AMT)+" "+URL_CUR+" — auto-triggering");'
    + 'dbgLog("url_amount",{AMT:AMT,CUR:URL_CUR,TXN:URL_TXN});'
    + 'setTimeout(openHP,500);'
    + '}'
    + 'dbgUpdate();'
    // After 5s, if still waiting log it
    + 'setTimeout(function(){'
    + 'if(AMT===0){'
    + 'msgLog.push("\u26a0\ufe0f 5s elapsed — no amount received (no postMessage + no URL params)");'
    + 'dbgUpdate();'
    + 'dbgLog("timeout_no_amount",{msgCount:msgLog.length,inIframe:inIframe});'
    + '}},5000);'
    + '})();'
    // Message listener — captures ALL messages for debug
    + 'window.addEventListener("message",function(e){'
    + 'var preview=typeof e.data==="string"?e.data.substring(0,200):JSON.stringify(e.data).substring(0,200);'
    + 'msgLog.push("\U0001f4e8 MSG from ["+e.origin+"]: "+preview);'
    + 'dbgUpdate();'
    + 'dbgLog("msg_received",{origin:e.origin,dtype:typeof e.data,preview:preview});'
    // Parse
    + 'var data;'
    + 'try{data=typeof e.data==="object"?e.data:JSON.parse(e.data);}catch(x){return;}'
    + 'if(!data)return;'
    + 'if(data.type==="PAYMENT_SUCCESS"){confirmPayment();return;}'
    + 'if(data.type==="payment_initiate_props"){'
    + 'AMT=jmd(data.amount,data.currency);'
    + 'DESC=data.description||data.name||"Payment";'
    + 'INV=data.entityId||data.invoiceId||data.orderId||"";'
    + 'window._GHL_TXN=data.transactionId||data.paymentIntentId||data.invoiceId||"";'
    + 'document.getElementById("a").textContent="J$"+Math.round(AMT).toLocaleString();'
    + 'document.getElementById("a").style.display="block";'
    + 'document.getElementById("l").textContent=DESC;'
    + 'document.getElementById("b").style.display="block";'
    + 'msgLog.push("\u2728 payment_initiate_props received! AMT=J$"+Math.round(AMT));'
    + 'dbgUpdate();'
    + 'setTimeout(openHP,500);}'
    + '});'
    + '<\/script>'
    + '</body></html>';

  res.end(html);
};
