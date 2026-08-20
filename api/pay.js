// api/pay.js — standalone Vercel serverless function
// GHL Custom Payment Provider iframe: GET /api/pay
//
// FIXES:
// 1. Reads amount + paymentIntentId from URL params server-side.
//    Calendar bookings pass everything in the URL; they do NOT send payment_initiate_props.
//    Invoice payments send payment_initiate_props; the message listener handles those.
// 2. poll checks qd.success===true (was qd.status==="succeeded", always undefined).
// 3. Single confirmPayment() function prevents double-confirm.
'use strict';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Use POST /api/create-native-session to create a payment session.' });
  }

  const q = req.query || {};
  const locationId  = q.locationId  || '';
  const currency    = (q.currency   || 'JMD').toUpperCase();
  const rawAmount   = parseFloat(q.amount) || 0;
  const ghlTxnId    = q.paymentIntentId || q.transactionId || '';
  const description = q.description || q.name || 'Invoice Payment';
  const entityId    = q.entityId || q.invoiceId || q.orderId || '';

  // GHL passes amount in smallest currency unit (cents for JMD = 1/100)
  // e.g. J$3,900 is sent as 390000. Convert to whole JMD.
  let amtJMD = 0;
  if (rawAmount > 0) {
    if (currency === 'USD') {
      const usd = rawAmount >= 100 ? rawAmount / 100 : rawAmount;
      amtJMD = Math.round(usd * 155);
    } else {
      // JMD or unknown: if >= 10000 assume cents, else already whole JMD
      amtJMD = rawAmount >= 10000 ? Math.round(rawAmount / 100) : rawAmount;
    }
  }

  // Allow GHL to iframe this page from any origin
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Type', 'text/html');

  // Pre-populate all JS variables server-side so the iframe works
  // for BOTH calendar (URL params only) and invoice (payment_initiate_props message) flows
  const jsL    = JSON.stringify(locationId);
  const jsAMT  = JSON.stringify(amtJMD);
  const jsDESC = JSON.stringify(description);
  const jsINV  = JSON.stringify(entityId);
  const jsTXN  = JSON.stringify(ghlTxnId);

  // If amount is known from URL, show button + auto-trigger immediately
  // If amount is 0, hide button and wait for payment_initiate_props message
  const btnDisplay  = amtJMD > 0 ? 'block'       : 'none';
  const amtDisplay  = amtJMD > 0 ? 'block'       : 'none';
  const amtText     = amtJMD > 0 ? 'J$' + Math.round(amtJMD).toLocaleString() : '';
  const lblText     = amtJMD > 0 ? description   : 'Loading payment details...';
  // Auto-open if we have URL amount (calendar flow); otherwise wait for message
  const autoOpen    = amtJMD > 0 ? 'setTimeout(openHP,600);' : '';

  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandyPay</title>'
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
    + '</head>'
    + '<body><div class="card">'
    + '<div class="logo">&#x1F4B3;</div>'
    + '<h2>HandyPay</h2>'
    + '<div class="amt" id="a">' + amtText + '</div>'
    + '<div class="lbl" id="l">' + lblText + '</div>'
    + '<button class="btn" id="b" onclick="openHP()">Open HandyPay Checkout</button>'
    + '<div class="st" id="s"></div>'
    + '</div>'
    + '<script>'
    // State: done=openHP called, confirmed=payment sent to GHL
    + 'var L=' + jsL + ',done=false,confirmed=false,SID="",poll=null;'
    // Pre-populated from URL params (calendar flow) — overridden by payment_initiate_props if received (invoice flow)
    + 'var AMT=' + jsAMT + ',DESC=' + jsDESC + ',INV=' + jsINV + ';'
    + 'window._GHL_TXN=' + jsTXN + ';'
    + 'function ss(t){document.getElementById("s").textContent=t;}'
    + 'function jmd(raw,cur){var n=parseFloat(raw)||0;if(!n)return 0;cur=(cur||"").toUpperCase();if(cur==="USD")return Math.round((n>=100?n/100:n)*155);if(cur==="JMD")return n>=10000?Math.round(n/100):n;return n;}'
    // Single confirm: fires once, prevents double-confirm from poll+message
    + 'function confirmPayment(){'
    + 'if(confirmed)return;confirmed=true;'
    + 'clearInterval(poll);'
    + 'ss("\u2705 Payment confirmed!");'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_success_response",chargeId:(window._GHL_TXN||SID)}),"*");'
    + 'setTimeout(function(){window.parent.postMessage(JSON.stringify({type:"custom_element_close_response"}),"*");},1500);}'
    // openHP: POST to /api/create-native-session, open checkout in new tab, poll for completion
    + 'function openHP(){'
    + 'if(done)return;done=true;'
    + 'document.getElementById("b").disabled=true;ss("Opening HandyPay...");'
    + 'fetch("/api/create-native-session",{method:"POST",headers:{"Content-Type":"application/json"},'
    + 'body:JSON.stringify({locationId:L,amountJMD:AMT,description:DESC,entityId:INV,ghlTransactionId:window._GHL_TXN||""})})'  
    + '.then(function(r){return r.json();})'  
    + '.then(function(d){'
    + 'if(!d.checkoutUrl){'
    + 'ss("Error: "+(d.error||"?"));'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_error_response",error:{description:d.error||"Payment session creation failed"}}),"*");'
    + 'document.getElementById("b").disabled=false;done=false;return;}'
    + 'SID=d.sessionId||d.paymentIntentId||"";'
    + 'var w=window.open(d.checkoutUrl,"_blank");'
    + 'if(!w){'
    + 'ss("Popup blocked — allow popups and click the button");'
    + 'document.getElementById("b").disabled=false;done=false;return;}'
    + 'ss("\u23F3 HandyPay open in new tab. Return here after paying.");'
    // POLL FIX: check qd.success===true not qd.status==="succeeded"
    + 'poll=setInterval(function(){'
    + 'if(!SID)return;'
    + 'fetch("/api/query?paymentIntentId="+SID)'
    + '.then(function(r){return r.json();})'  
    + '.then(function(qd){'
    + 'if(qd.success===true){confirmPayment();}'
    + 'else if(qd.failed===true||qd.status==="cancelled"){clearInterval(poll);ss("Payment cancelled. Click the button to try again.");done=false;document.getElementById("b").disabled=false;}'
    + '}).catch(function(){});'
    + '},3000);'
    + '})'
    + '.catch(function(e){'
    + 'ss("Error: "+e.message);'
    + 'window.parent.postMessage(JSON.stringify({type:"custom_element_error_response",error:{description:e.message||"Payment error"}}),"*");'
    + 'document.getElementById("b").disabled=false;done=false;});'
    + '}'
    // Message listener: payment_initiate_props (invoice flow) + PAYMENT_SUCCESS (opener backup)
    + 'window.addEventListener("message",function(e){'
    + 'var data;try{data=JSON.parse(e.data);}catch(x){return;}'
    + 'if(data&&data.type==="PAYMENT_SUCCESS"){confirmPayment();return;}'
    + 'if(data&&data.type==="payment_initiate_props"&&!done){'
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
    // Auto-open if amount came from URL (calendar flow)
    + autoOpen
    + '<\/script>'
    + '</body></html>';

  res.end(html);
};
