// api/pay.js — standalone Vercel serverless function
// GHL Custom Payment Provider iframe: GET /api/pay
//
// FIX (critical): poll was checking qd.status==="succeeded" but /api/query GET
// returns {success:true, chargeSnapshot:{status:"succeeded",...}}.
// qd.status at top level is always undefined → poll never fired → appointment never confirmed.
// Fixed: check qd.success===true instead.
//
// Also fixed: separate `confirmed` flag prevents double-confirm if both poll
// and window.opener message fire; removed !done guard that blocked PAYMENT_SUCCESS.
'use strict';

module.exports = async function handler(req, res) {
  // POST not used here — iframe calls /api/create-native-session directly
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Use POST /api/create-native-session to create a payment session.' });
  }

  const locationId = (req.query && req.query.locationId) || '';

  // Allow GHL to load this in an iframe
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Type', 'text/html');

  const L = JSON.stringify(locationId);

  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandyPay</title>'
    + '<style>'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f8faff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}'
    + '.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;width:100%;padding:40px;text-align:center}'
    + '.logo{font-size:48px;margin-bottom:8px}'
    + 'h2{font-size:20px;font-weight:800;color:#1a1a1a;margin-bottom:16px}'
    + '.amt{font-size:32px;font-weight:800;color:#15803d;margin-bottom:8px;display:none}'
    + '.lbl{font-size:14px;color:#666;margin-bottom:24px}'
    + '.btn{background:#15803d;color:#fff;border:none;border-radius:10px;padding:14px 28px;font-size:16px;font-weight:700;cursor:pointer;width:100%;display:none;margin-bottom:8px}'
    + '.btn:disabled{opacity:.6;cursor:not-allowed}'
    + '.st{font-size:14px;color:#555;margin-top:16px;min-height:20px}'
    + '</style>'
    + '</head>'
    + '<body><div class="card">'
    + '<div class="logo">&#x1F4B3;</div>'
    + '<h2>HandyPay</h2>'
    + '<div class="amt" id="a"></div>'
    + '<div class="lbl" id="l">Loading payment details...</div>'
    + '<button class="btn" id="b" onclick="openHP()">Open HandyPay Checkout</button>'
    + '<div class="st" id="s"></div>'
    + '</div>'
    + '<script>'
    // State vars: done = openHP called, confirmed = payment confirmed to GHL
    + 'var L=' + L + ',done=false,confirmed=false,SID="",poll=null,AMT=0,DESC="Invoice Payment",INV="";'
    + 'function ss(t){document.getElementById("s").textContent=t;}'
    // JMD amount helper
    + 'function jmd(raw,cur){var n=parseFloat(raw)||0;if(!n)return 0;cur=(cur||"").toUpperCase();if(cur==="USD")return Math.round((n>=100?n/100:n)*155);if(cur==="JMD")return n>=10000?Math.round(n/100):n;return n;}'
    // Single confirm function — fires once, prevents double-confirm
    + 'function confirmPayment(){'
    + 'if(confirmed)return;confirmed=true;'
    + 'clearInterval(poll);'
    + 'ss("\u2705 Payment confirmed! You can close this tab.");'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_success_response",chargeId:(window._GHL_TXN||SID)}),"*");'
    + 'setTimeout(function(){window.parent.postMessage(JSON.stringify({type:"custom_element_close_response"}),"*");},1500);}'
    // openHP: call /api/create-native-session, open checkout in new tab, start polling
    + 'function openHP(){'
    + 'if(done)return;done=true;'
    + 'document.getElementById("b").disabled=true;ss("Opening HandyPay...");'
    + 'fetch("/api/create-native-session",{method:"POST",headers:{"Content-Type":"application/json"},'
    + 'body:JSON.stringify({locationId:L,amountJMD:AMT,description:DESC,entityId:INV,ghlTransactionId:window._GHL_TXN||""})})'  
    + '.then(function(r){return r.json();})'
    + '.then(function(d){'
    + 'if(!d.checkoutUrl){ss("Error: "+(d.error||"?"));'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_error_response",error:{description:d.error||"Payment session creation failed"}}),"*");'
    + 'document.getElementById("b").disabled=false;done=false;return;}'
    + 'SID=d.sessionId||d.paymentIntentId||"";'
    + 'var w=window.open(d.checkoutUrl,"_blank");'
    + 'if(!w){ss("Popup blocked — allow popups and click the button");document.getElementById("b").disabled=false;done=false;return;}'
    + 'ss("\u23F3 HandyPay open in new tab. Return here after paying.");'
    // POLL: FIX — check qd.success===true (API returns {success:true,chargeSnapshot:{...}})
    // qd.status was always undefined because status is nested inside chargeSnapshot
    + 'poll=setInterval(function(){'
    + 'if(!SID)return;'
    + 'fetch("/api/query?paymentIntentId="+SID)'
    + '.then(function(r){return r.json();})'
    + '.then(function(qd){'
    + 'if(qd.success===true){confirmPayment();}'
    // also handle failed/expired
    + 'else if(qd.failed===true||qd.status==="cancelled"){clearInterval(poll);ss("Payment was cancelled or failed. Please try again.");done=false;document.getElementById("b").disabled=false;}'
    + '}).catch(function(){});'
    + '},3000);'
    + '})'
    + '.catch(function(e){ss("Error: "+e.message);'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_error_response",error:{description:e.message||"Payment error"}}),"*");'
    + 'document.getElementById("b").disabled=false;done=false;});'
    + '}'
    // Message listener: handles PAYMENT_SUCCESS from window.opener
    // and payment_initiate_props from GHL (auto-triggers openHP after 500ms)
    + 'window.addEventListener("message",function(e){'
    + 'var data;try{data=JSON.parse(e.data);}catch(x){return;}'
    + 'if(data&&data.type==="PAYMENT_SUCCESS"){confirmPayment();return;}'
    + 'if(data&&data.type==="payment_initiate_props"){'
    + 'AMT=jmd(data.amount,data.currency);'
    + 'DESC=data.description||data.name||"Invoice Payment";'
    + 'INV=data.entityId||data.invoiceId||data.orderId||"";'
    + 'window._GHL_TXN=data.transactionId||data.invoiceId||"";'
    + 'document.getElementById("a").textContent="J$"+Math.round(AMT).toLocaleString();'
    + 'document.getElementById("a").style.display="block";'
    + 'document.getElementById("l").textContent=DESC;'
    + 'document.getElementById("b").style.display="block";'
    + 'setTimeout(openHP,500);}'
    + '});'
    + '<\/script>'
    + '</body></html>';

  res.end(html);
};
