// api/pay.js — GHL Custom Payment Provider iframe
//
// FIXES:
// 1. e.data handled as plain object OR JSON string.
//    GHL invoice page sends JSON string; GHL calendar sends plain object.
//    JSON.parse(plainObject) fails silently — that was why calendar showed 'Loading...' forever.
// 2. Sends 'payment_ready' signal so GHL knows iframe loaded and delivers payment_initiate_props.
// 3. Reads amount/paymentIntentId from URL params as fallback (in case GHL appends them).
// 4. poll checks qd.success===true (not qd.status==="succeeded").
// 5. Single confirmPayment() prevents double-confirm.
'use strict';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Use POST /api/create-native-session.' });
  }

  const q = req.query || {};
  const locationId  = q.locationId  || '';
  const currency    = (q.currency   || 'JMD').toUpperCase();
  const rawAmount   = parseFloat(q.amount) || 0;
  const ghlTxnId    = q.paymentIntentId || q.transactionId || '';
  const description = q.description || q.name || 'Invoice Payment';
  const entityId    = q.entityId || q.invoiceId || q.orderId || '';

  // Convert smallest-unit amount to whole JMD
  // GHL sends e.g. 390000 for J$3,900 (cents) or may send 3900 directly
  let amtJMD = 0;
  if (rawAmount > 0) {
    if (currency === 'USD') {
      amtJMD = Math.round((rawAmount >= 100 ? rawAmount / 100 : rawAmount) * 155);
    } else {
      amtJMD = rawAmount >= 10000 ? Math.round(rawAmount / 100) : rawAmount;
    }
  }

  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Type', 'text/html');

  const jsL    = JSON.stringify(locationId);
  const jsAMT  = JSON.stringify(amtJMD);
  const jsDESC = JSON.stringify(description);
  const jsINV  = JSON.stringify(entityId);
  const jsTXN  = JSON.stringify(ghlTxnId);

  // If amount known from URL: show amount + button immediately; auto-open checkout
  // If amount=0: show spinner, wait for payment_initiate_props from GHL
  const amtDisplay = amtJMD > 0 ? 'block' : 'none';
  const btnDisplay = amtJMD > 0 ? 'block' : 'none';
  const amtText    = amtJMD > 0 ? 'J$' + Math.round(amtJMD).toLocaleString() : '';
  const lblText    = amtJMD > 0 ? description : 'Loading payment details...';
  const autoOpen   = amtJMD > 0 ? 'setTimeout(openHP,600);' : '';

  const html = '<!DOCTYPE html><html><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>HandyPay</title>'
    + '<style>'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f8faff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}'
    + '.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;width:100%;padding:40px;text-align:center}'
    + '.logo{font-size:48px;margin-bottom:8px}'
    + 'h2{font-size:20px;font-weight:800;color:#1a1a1a;margin-bottom:16px}'
    + '.amt{font-size:32px;font-weight:800;color:#15803d;margin-bottom:8px;display:' + amtDisplay + '}'
    + '.lbl{font-size:14px;color:#666;margin-bottom:24px}'
    + '.btn{background:#15803d;color:#fff;border:none;border-radius:10px;padding:14px 28px;font-size:16px;font-weight:700;cursor:pointer;width:100%;display:' + btnDisplay + ';margin-bottom:8px}'
    + '.btn:disabled{opacity:.6;cursor:not-allowed}'
    + '.st{font-size:14px;color:#555;margin-top:16px;min-height:20px}'
    + '</style>'
    + '</head><body>'
    + '<div class="card">'
    + '<div class="logo">&#x1F4B3;</div>'
    + '<h2>HandyPay</h2>'
    + '<div class="amt" id="a">' + amtText + '</div>'
    + '<div class="lbl" id="l">' + lblText + '</div>'
    + '<button class="btn" id="b" onclick="openHP()">Open HandyPay Checkout</button>'
    + '<div class="st" id="s"></div>'
    + '</div>'
    + '<script>'
    + 'var L=' + jsL + ',done=false,confirmed=false,SID="",poll=null;'
    + 'var AMT=' + jsAMT + ',DESC=' + jsDESC + ',INV=' + jsINV + ';'
    + 'window._GHL_TXN=' + jsTXN + ';'

    // Helper: show status text
    + 'function ss(t){document.getElementById("s").textContent=t;}'

    // JMD conversion: handles cents vs whole units
    + 'function jmd(raw,cur){'
    + 'var n=parseFloat(raw)||0;if(!n)return 0;'
    + 'cur=(cur||"").toUpperCase();'
    + 'if(cur==="USD")return Math.round((n>=100?n/100:n)*155);'
    + 'return n>=10000?Math.round(n/100):n;}'

    // FIX 1: parse e.data as object OR JSON string
    // GHL calendar sends plain object; GHL invoice sends JSON string
    // JSON.parse(plainObject) fails silently — this was the root bug
    + 'function parseMsg(e){'
    + 'if(!e||e.data===undefined||e.data===null)return null;'
    + 'if(typeof e.data==="object")return e.data;'
    + 'if(typeof e.data==="string"){try{return JSON.parse(e.data);}catch(x){return null;}}'
    + 'return null;}'

    // Single confirm: fires once, sends success + close to GHL
    + 'function confirmPayment(){'
    + 'if(confirmed)return;confirmed=true;'
    + 'clearInterval(poll);'
    + 'ss("\u2705 Payment confirmed!");'
    + 'var cid=window._GHL_TXN||SID;'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_success_response",chargeId:cid}),"*");'
    + 'window.parent.postMessage({type:"custom_element_success_response",chargeId:cid},"*");'
    + 'setTimeout(function(){'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_close_response"}),"*");'
    + 'window.parent.postMessage({type:"custom_element_close_response"},"*");'
    + '},1500);}'

    // openHP: create session, open checkout in new tab, poll every 3s
    + 'function openHP(){'
    + 'if(done)return;done=true;'
    + 'document.getElementById("b").disabled=true;'
    + 'ss("Opening HandyPay...");'
    + 'fetch("/api/create-native-session",{'
    + 'method:"POST",'
    + 'headers:{"Content-Type":"application/json"},'
    + 'body:JSON.stringify({locationId:L,amountJMD:AMT,description:DESC,entityId:INV,ghlTransactionId:window._GHL_TXN||""})'  
    + '}).then(function(r){return r.json();})'  
    + '.then(function(d){'
    + 'if(!d.checkoutUrl){'
    + 'ss("Error: "+(d.error||"No checkout URL"));'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_error_response",error:{description:d.error||"Session creation failed"}}),"*");'
    + 'document.getElementById("b").disabled=false;done=false;return;}'
    + 'SID=d.sessionId||d.paymentIntentId||"";'
    + 'var w=window.open(d.checkoutUrl,"_blank");'
    + 'if(!w){ss("Popup blocked — allow popups and retry");document.getElementById("b").disabled=false;done=false;return;}'
    + 'ss("\u23F3 HandyPay open in new tab. Return here after paying.");'
    // POLL FIX: check qd.success===true (not qd.status==="succeeded")
    + 'poll=setInterval(function(){'
    + 'if(!SID)return;'
    + 'fetch("/api/query?paymentIntentId="+SID)'
    + '.then(function(r){return r.json();})'  
    + '.then(function(qd){'
    + 'if(qd.success===true){confirmPayment();}'
    + 'else if(qd.failed===true){clearInterval(poll);ss("Payment failed. Click button to retry.");done=false;document.getElementById("b").disabled=false;}'
    + '}).catch(function(){});'
    + '},3000);'
    + '})'
    + '.catch(function(e){'
    + 'ss("Error: "+e.message);'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_error_response",error:{description:e.message}}),"*");'
    + 'document.getElementById("b").disabled=false;done=false;});'
    + '}'

    // FIX 2: message listener handles both plain object and JSON string
    + 'window.addEventListener("message",function(e){'
    + 'var data=parseMsg(e);if(!data)return;'
    + 'if(data.type==="PAYMENT_SUCCESS"){confirmPayment();return;}'
    + 'if(data.type==="payment_initiate_props"&&!done){'
    + 'AMT=jmd(data.amount,data.currency);'
    + 'DESC=data.description||data.name||"Payment";'
    + 'INV=data.entityId||data.invoiceId||data.orderId||"";'
    + 'window._GHL_TXN=data.transactionId||data.paymentIntentId||data.invoiceId||"";'
    + 'document.getElementById("a").textContent="J$"+Math.round(AMT).toLocaleString();'
    + 'document.getElementById("a").style.display="block";'
    + 'document.getElementById("l").textContent=DESC;'
    + 'document.getElementById("b").style.display="block";'
    + 'if(AMT>0)setTimeout(openHP,500);'
    + '}'
    + '});'

    // FIX 3: send ready signal so GHL knows iframe loaded and delivers payment_initiate_props
    // Send both JSON string and plain object format; retry every 2s for 10s in case GHL missed it
    + '(function(){'
    + 'var tries=0;'
    + 'function sendReady(){'
    + 'window.parent.postMessage(JSON.stringify({type:"payment_ready"}),"*");'
    + 'window.parent.postMessage({type:"payment_ready"},"*");'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_loaded"}),"*");'
    + 'window.parent.postMessage({type:"custom_element_loaded"},"*");'
    + 'tries++;if(tries<5&&!done)setTimeout(sendReady,2000);}'
    + 'sendReady();'
    + '})();'

    // Auto-open if amount was in URL (calendar sends it that way sometimes)
    + autoOpen
    + '<\/script>'
    + '</body></html>';

  res.end(html);
};
