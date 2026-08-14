// ============================================================
// GHL CUSTOM PAYMENT PROVIDER - CORRECT PROTOCOL
// Protocol (all messages JSON.stringify'd strings):
//   Iframe → GHL: {"type":"custom_provider_ready","loaded":true}
//   GHL → Iframe: {"type":"payment_initiate_props","amount":X,"currency":"JMD","invoiceId":"xxx",...}
//   Iframe → GHL: {"type":"custom_element_success_response","chargeId":"sessionId"}
// ============================================================
app.get('/api/pay', async (req, res) => {
  try {
    var q = req.query;
    var locationId = q.locationId || q.location_id || q.altId || '';
    console.log('[/api/pay GET] locationId:', locationId, 'params:', JSON.stringify(q));
    if (!locationId) {
      return res.status(400).send('<html><body style="font-family:sans-serif;padding:40px"><h2>HandyPay Error</h2><p>Missing locationId.</p></body></html>');
    }
    var cfg = await getMerchantConfig(locationId);
    if (!cfg || !cfg.handypay_api_key) {
      return res.status(400).send('<html><body style="font-family:sans-serif;padding:40px"><h2>HandyPay not configured</h2><p>Open HandyPay Settings to connect.</p></body></html>');
    }
    var locId = locationId;
    var html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandyPay</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f4f6fb;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}.card{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.09);padding:28px;max-width:380px;width:100%;text-align:center}.logo{font-size:36px;margin-bottom:10px}h2{color:#D10039;font-size:18px;font-weight:800;margin-bottom:4px}.amt{font-size:32px;font-weight:900;color:#1a1a1a;margin:10px 0}.lbl{font-size:13px;color:#888;margin-bottom:16px}.btn{width:100%;background:#D10039;color:#fff;border:none;border-radius:9px;padding:13px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:8px}.btn:disabled{background:#ccc}.st{font-size:13px;color:#555;margin-top:4px}.err{color:#b91c1c}.spin{display:inline-block;width:20px;height:20px;border:2px solid #f0f0f0;border-top-color:#D10039;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:6px}@keyframes spin{to{transform:rotate(360deg)}}</style>
</head>
<body><div class="card"><div class="logo">&#x1F4B3;</div><h2>HandyPay</h2>
<div class="amt" id="amt-display" style="display:none"></div>
<div class="lbl" id="amt-lbl">Loading payment details...</div>
<button class="btn" id="btn" onclick="openHP()" style="display:none">Open HandyPay Checkout</button>
<div class="st" id="st"></div>
</div>
<script>
var LOC="${ locId }",done=false,SID='',pollTimer=null;

function jmdFrom(raw,cur){
  var n=parseFloat(raw)||0;if(!n)return 0;
  cur=(cur||'').toUpperCase();
  if(cur==='USD')return Math.round((n>=100?n/100:n)*155);
  return n; // JMD already in full units (2000 = J$2000)
}

function setStatus(s,isErr){var el=document.getElementById('st');el.textContent=s;if(isErr)el.className='st err';}

function openHP(){
  if(done)return;
  document.getElementById('btn').disabled=true;
  setStatus('Opening HandyPay...');
  fetch('/api/create-native-session',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({locationId:LOC,amountJMD:window._amtJMD||0,description:window._desc||'Invoice Payment',entityId:window._invId||''})})
  .then(function(r){return r.json();})
  .then(function(d){
    if(!d.checkoutUrl){setStatus('Error: '+(d.error||'?'),true);document.getElementById('btn').disabled=false;return;}
    SID=d.sessionId||d.paymentIntentId||'';
    var w=window.open(d.checkoutUrl,'_blank');
    if(!w){setStatus('Click to open: <a href="'+d.checkoutUrl+'" target="_blank">HandyPay Checkout</a>');document.getElementById('btn').disabled=false;done=false;return;}
    done=true;
    setStatus('&#x23F3; HandyPay opened. Return here after paying.');
    // Poll every 3s
    pollTimer=setInterval(function(){
      if(!SID)return;
      fetch('/api/query?paymentIntentId='+SID).then(function(r){return r.json();}).then(function(qd){
        if(qd.status==='succeeded'){
          clearInterval(pollTimer);
          setStatus('&#x2705; Payment confirmed!');
          // Notify GHL with correct protocol (JSON string, custom_element_success_response)
          window.parent.postMessage(JSON.stringify({type:'custom_element_success_response',chargeId:SID}),'*');
          // Also try close after short delay
          setTimeout(function(){window.parent.postMessage(JSON.stringify({type:'custom_element_close_response'}),'*');},1500);
        }
      }).catch(function(){});
    },3000);
  })
  .catch(function(e){setStatus('Error: '+e.message,true);document.getElementById('btn').disabled=false;done=false;});
}

// Listen for GHL's payment_initiate_props message
window.addEventListener('message',function(e){
  var data;
  try{data=JSON.parse(e.data);}catch(x){return;} // GHL sends JSON strings
  console.log('[HP iframe] msg type:', data.type, 'from:', e.origin);
  if(data.type==='payment_initiate_props'){
    // GHL sent us amount + invoiceId!
    var rawAmt=data.amount||0;
    var cur=data.currency||'JMD';
    window._amtJMD=jmdFrom(rawAmt,cur);
    window._desc=data.description||data.name||'Invoice Payment';
    window._invId=data.invoiceId||data.orderId||'';
    document.getElementById('amt-display').textContent='J// ============================================================
// GHL PAYMENT IFRAME - SERVER-SIDE INVOICE LOOKUP + REDIRECT
// GHL opens GET /api/pay?locationId=xxx (only locationId sent)
// We look up pending invoices via CRM API, create HandyPay session, redirect
// ============================================================
app.get('/api/pay', async (req, res) => {
  try {
    var q = req.query;
    var locationId = q.locationId || q.location_id || q.altId || '';
    console.log('[/api/pay GET] locationId:', locationId, 'all params:', JSON.stringify(q));
    if (!locationId) {
      return res.status(400).send('<html><body style="font-family:sans-serif;padding:40px"><h2>HandyPay Error</h2><p>Missing locationId. Params: ' + JSON.stringify(q) + '</p></body></html>');
    }
    var cfg = await getMerchantConfig(locationId);
    if (!cfg || !cfg.handypay_api_key) {
      return res.status(400).send('<html><body style="font-family:sans-serif;padding:40px"><h2>HandyPay not configured</h2><p>Open HandyPay Settings to connect.</p></body></html>');
    }

    // Try to get CRM token + look up pending invoices
    var token = cfg.crm_access_token;
    var amountJMD = 0, description = 'Invoice Payment', contactId = '', entityId = '';

    if (token) {
      try {
        // Query GHL for sent/unpaid invoices for this location
        var invResp = await fetch(GHL_API + '/invoices/?altId=' + locationId + '&altType=location&status=sent&limit=5&offset=0', {
          headers: { 'Authorization': 'Bearer ' + token, 'Version': '2021-07-28' }
        });
        if (invResp.status === 401) {
          token = await refreshCrmToken(locationId);
          invResp = await fetch(GHL_API + '/invoices/?altId=' + locationId + '&altType=location&status=sent&limit=5', {
            headers: { 'Authorization': 'Bearer ' + token, 'Version': '2021-07-28' }
          });
        }
        var invData = await invResp.json();
        var invoices = (invData.data && invData.data.invoices) || invData.invoices || invData.data || [];
        console.log('[/api/pay GET] invoices found:', invoices.length);
        if (invoices.length > 0) {
          var inv = invoices[0]; // most recent unpaid invoice
          // GHL invoice amounts: total is in the currency (JMD for JMD invoices)
          var rawTotal = inv.total || inv.amountDue || inv.amount || 0;
          amountJMD = parseFloat(rawTotal) || 0;
          description = inv.title || inv.name || 'Invoice ' + (inv.invoiceNumber || '');
          contactId = (inv.contactDetails && inv.contactDetails.id) || inv.contactId || '';
          entityId = inv._id || inv.id || '';
          console.log('[/api/pay GET] invoice:', entityId, 'amount:', amountJMD, 'desc:', description);
        }
      } catch (e) {
        console.error('[/api/pay GET] invoice lookup error:', e.message);
      }
    }

    if (amountJMD >= 80) {
      // Create HandyPay session and redirect immediately
      var session = await createHandyPaySession(
        cfg.handypay_api_key, amountJMD, description,
        { contact_id: contactId, location_id: locationId, entity_id: entityId, payment_type: 'ghl_native' }, true
      );
      var sessionId = session.id || session.sessionId || session.session_id;
      var checkoutUrl = session.url || session.checkout_url || session.checkoutUrl;
      await pool.query(
        `INSERT INTO payment_logs (session_id,location_id,contact_id,amount,currency,status,payment_type,checkout_url)
         VALUES ($1,$2,$3,$4,'JMD','pending','ghl_native',$5)
         ON CONFLICT (session_id) DO UPDATE SET checkout_url=$5,updated_at=NOW()`,
        [sessionId, locationId, contactId, Math.round(amountJMD), checkoutUrl]
      );
      console.log('[/api/pay GET] serving open-tab page:', sessionId, amountJMD);
      var cu = checkoutUrl, sid = sessionId, amt = amountJMD;
      var openHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandyPay</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f4f6fb;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}.card{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.09);padding:28px;max-width:380px;width:100%;text-align:center}.logo{font-size:36px;margin-bottom:10px}h2{color:#D10039;font-size:18px;font-weight:800;margin-bottom:4px}.amt{font-size:28px;font-weight:900;color:#1a1a1a;margin:12px 0}.lbl{font-size:12px;color:#888;margin-bottom:16px}.btn{width:100%;background:#D10039;color:#fff;border:none;border-radius:9px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:10px}.btn:disabled{background:#ccc}.st{font-size:13px;color:#555;margin-top:6px}</style></head>
<body><div class="card"><div class="logo">&#x1F4B3;</div><h2>HandyPay</h2>
<div class="amt">J${ amt.toLocaleString() }</div>
<div class="lbl">Invoice Payment</div>
<button class="btn" id="btn" onclick="openHP()">Open HandyPay Checkout</button>
<div class="st" id="st">Click above to complete your payment</div>
</div>
<script>
var URL=\`${ cu }\`, SID=\`${ sid }\`, done=false;
function openHP(){
  if(done)return; done=true;
  document.getElementById('btn').disabled=true;
  document.getElementById('st').textContent='Opening HandyPay...';
  var w=window.open(URL,'_blank','noopener');
  if(!w){document.getElementById('st').textContent='Popup blocked. Click below:';document.getElementById('btn').disabled=false;done=false;return;}
  document.getElementById('st').textContent='HandyPay opened in new tab. Complete payment there, then return.';
  // Poll DB every 3s to check if payment completed
  var poll=setInterval(function(){
    fetch('/api/query?paymentIntentId='+SID).then(function(r){return r.json();}).then(function(d){
      if(d.status==='succeeded'){
        clearInterval(poll);
        document.getElementById('st').textContent='Payment confirmed! ✅';
        window.parent.postMessage({type:'PAYMENT_SUCCESS',paymentIntentId:SID,status:'succeeded'},'*');
        window.parent.postMessage({event:'payment-success',paymentIntentId:SID},'*');
      }
    }).catch(function(){});
  },3000);
}
// Auto-open after 1s
setTimeout(openHP,1000);
// Also listen for postMessage from success page (if window.open worked)
window.addEventListener('message',function(e){
  var d=e.data||{};
  if(d.paymentIntentId||d.type==='PAYMENT_SUCCESS'){
    window.parent.postMessage({type:'PAYMENT_SUCCESS',paymentIntentId:d.paymentIntentId||SID,status:'succeeded'},'*');
    document.getElementById('st').textContent='Payment confirmed! ✅';
  }
});
</script></body></html>`;
      res.setHeader('Content-Type','text/html');
      return res.send(openHtml);
    }

    // Fallback: show manual input page (amount unknown)
    var locId = locationId;
    var html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandyPay</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f4f6fb;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}.card{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.09);padding:28px;max-width:380px;width:100%}.logo{font-size:32px;text-align:center;margin-bottom:10px}h2{color:#D10039;font-size:17px;font-weight:800;text-align:center;margin-bottom:12px}label{display:block;font-size:13px;font-weight:700;color:#333;margin-bottom:4px}input{width:100%;border:1.5px solid #ccc;border-radius:8px;padding:10px;font-size:16px;margin-bottom:12px;outline:none}input:focus{border-color:#D10039}.btn{width:100%;background:#D10039;color:#fff;border:none;border-radius:9px;padding:13px;font-size:15px;font-weight:700;cursor:pointer}.status{font-size:12px;color:#888;text-align:center;margin-top:8px}.err{color:#b91c1c}</style>
</head>
<body><div class="card"><div class="logo">&#x1F4B3;</div><h2>HandyPay</h2>
<label>Amount (JMD)</label>
<input type="number" id="amt" placeholder="e.g. 2000" min="80" step="1" autofocus>
<button class="btn" onclick="pay()">Pay with HandyPay</button>
<div class="status" id="st"></div>
</div>
<script>
var L="${ locId }",done=false;
function pay(){
  if(done)return;
  var a=parseFloat(document.getElementById('amt').value)||0;
  if(a<80){document.getElementById('st').textContent='Min J$80';document.getElementById('st').className='status err';return;}
  done=true;document.getElementById('st').textContent='Creating session...';
  fetch('/api/create-native-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({locationId:L,amountJMD:a,description:'Invoice Payment'})})
  .then(function(r){return r.json();})
  .then(function(d){
    if(d.checkoutUrl){
      var sid=d.sessionId||d.paymentIntentId||'';
      document.getElementById('st').textContent='Opening HandyPay...';
      var w=window.open(d.checkoutUrl,'_blank');
      if(!w){document.getElementById('st').textContent='Popup blocked — click: <a href="'+d.checkoutUrl+'" target="_blank">Open HandyPay</a>';done=false;document.getElementById('btn').disabled=false;return;}
      document.getElementById('st').textContent='HandyPay opened in new tab. Return here after paying.';
      if(sid){var poll=setInterval(function(){fetch('/api/query?paymentIntentId='+sid).then(function(r){return r.json();}).then(function(qd){if(qd.status==='succeeded'){clearInterval(poll);document.getElementById('st').textContent='Payment confirmed! ✅';window.parent.postMessage({type:'PAYMENT_SUCCESS',paymentIntentId:sid,status:'succeeded'},'*');}}).catch(function(){});},3000);}
    }else{document.getElementById('st').textContent='Error: '+(d.error||'?');document.getElementById('st').className='status err';done=false;}
  })
  .catch(function(e){document.getElementById('st').textContent='Error: '+e.message;done=false;});
}
</script>
</body></html>`;
    res.setHeader('Content-Type','text/html');
    return res.send(html);
  } catch (e) {
    console.error('[/api/pay GET] CRASH:', e.message);
    return res.status(500).send('<h2>HandyPay Error: ' + e.message + '</h2>');
  }
});

app.post('/api/create-native-session', async (req, res) => {
  try {
    var locationId=req.body.locationId, amountJMD=parseFloat(req.body.amountJMD)||0;
    var description=req.body.description||'Invoice Payment', contactId=req.body.contactId||'', entityId=req.body.entityId||'';
    console.log('[create-native-session]',locationId,amountJMD);
    if(!locationId||amountJMD<80) return res.status(400).json({error:'Need locationId+amountJMD>=80. Got:'+amountJMD});
    var cfg=await getMerchantConfig(locationId);
    if(!cfg||!cfg.handypay_api_key) return res.status(400).json({error:'Not configured: '+locationId});
    var session=await createHandyPaySession(cfg.handypay_api_key,amountJMD,description,
      {contact_id:contactId,location_id:locationId,entity_id:entityId,payment_type:'ghl_native'},true);
    var sessionId=session.id||session.sessionId||session.session_id;
    var checkoutUrl=session.url||session.checkout_url||session.checkoutUrl;
    await pool.query(
      `INSERT INTO payment_logs (session_id,location_id,contact_id,amount,currency,status,payment_type,checkout_url)
       VALUES ($1,$2,$3,$4,'JMD','pending','ghl_native',$5)
       ON CONFLICT (session_id) DO UPDATE SET checkout_url=$5,updated_at=NOW()`,
      [sessionId,locationId,contactId,Math.round(amountJMD),checkoutUrl]
    );
    console.log('[create-native-session] ok:',sessionId);
    return res.json({sessionId,checkoutUrl,paymentIntentId:sessionId});
  } catch(e){
    console.error('[create-native-session] ERR:',e.message);
    return res.status(500).json({error:e.message});
  }
});

// ============================================================
// DEBUG MESSAGE CAPTURE (postMessages from GHL iframe)
// ============================================================
app.post('/api/debug-message', async (req, res) => {
  try {
    await pool.query('INSERT INTO debug_messages (location_id,message,origin) VALUES ($1,$2,$3)',
      [req.body.locationId||'',JSON.stringify(req.body.message||{}),req.body.origin||'']).catch(function(){});
    return res.json({ok:true});
  } catch(e){return res.json({ok:false});}
});

app.get('/api/debug-messages', async (req, res) => {
  if(req.query.secret!==process.env.INIT_SECRET) return res.status(403).json({error:'Forbidden'});
  try {
    var rows=(await pool.query('SELECT * FROM debug_messages ORDER BY created_at DESC LIMIT 20')).rows;
    return res.json({count:rows.length,messages:rows});
  } catch(e){return res.json({error:e.message,note:'Run /api/init-db first'});}
});


app.post('/api/re-register', async (req, res) => {
  if (req.query.secret !== process.env.INIT_SECRET) return res.status(403).json({ error: 'forbidden' });
  var locationId = req.query.locationId;
  if (!locationId) return res.status(400).json({ error: 'Missing locationId' });
  var cfg = await getMerchantConfig(locationId);
  if (!cfg) return res.status(404).json({ error: 'Location not found in DB' });
  var token = cfg.crm_access_token;
  if (!token) {
    try { token = await refreshCrmToken(locationId); } catch(e) { return res.status(400).json({ error: 'No CRM token: ' + e.message }); }
  }
  var result = await registerPaymentProvider(locationId, token);
  var result2 = await activatePaymentModes(locationId, token, cfg.handypay_api_key || 'hp_pending_setup', cfg.mode || 'test');
  return res.json({ ok: true, register: result, activate: result2 });
});



module.exports = app;
+window._amtJMD.toLocaleString();
    document.getElementById('amt-display').style.display='block';
    document.getElementById('amt-lbl').textContent='Invoice Payment';
    document.getElementById('btn').style.display='block';
    // Auto-trigger payment
    setTimeout(openHP, 500);
  }
});

// Signal ready to GHL (JSON string format, REQUIRED)
try{
  window.parent.postMessage(JSON.stringify({type:'custom_provider_ready',loaded:true}),'*');
}catch(x){setStatus('Blocked: '+x.message,true);}
</script>
</body></html>`;
    res.setHeader('Content-Type','text/html');
    return res.send(html);
  } catch(e) {
    console.error('[/api/pay GET] CRASH:', e.message);
    return res.status(500).send('<h2>HandyPay Error: '+e.message+'</h2>');
  }
});

// ============================================================
// GHL PAYMENT IFRAME - SERVER-SIDE INVOICE LOOKUP + REDIRECT
// GHL opens GET /api/pay?locationId=xxx (only locationId sent)
// We look up pending invoices via CRM API, create HandyPay session, redirect
// ============================================================
app.get('/api/pay', async (req, res) => {
  try {
    var q = req.query;
    var locationId = q.locationId || q.location_id || q.altId || '';
    console.log('[/api/pay GET] locationId:', locationId, 'all params:', JSON.stringify(q));
    if (!locationId) {
      return res.status(400).send('<html><body style="font-family:sans-serif;padding:40px"><h2>HandyPay Error</h2><p>Missing locationId. Params: ' + JSON.stringify(q) + '</p></body></html>');
    }
    var cfg = await getMerchantConfig(locationId);
    if (!cfg || !cfg.handypay_api_key) {
      return res.status(400).send('<html><body style="font-family:sans-serif;padding:40px"><h2>HandyPay not configured</h2><p>Open HandyPay Settings to connect.</p></body></html>');
    }

    // Try to get CRM token + look up pending invoices
    var token = cfg.crm_access_token;
    var amountJMD = 0, description = 'Invoice Payment', contactId = '', entityId = '';

    if (token) {
      try {
        // Query GHL for sent/unpaid invoices for this location
        var invResp = await fetch(GHL_API + '/invoices/?altId=' + locationId + '&altType=location&status=sent&limit=5&offset=0', {
          headers: { 'Authorization': 'Bearer ' + token, 'Version': '2021-07-28' }
        });
        if (invResp.status === 401) {
          token = await refreshCrmToken(locationId);
          invResp = await fetch(GHL_API + '/invoices/?altId=' + locationId + '&altType=location&status=sent&limit=5', {
            headers: { 'Authorization': 'Bearer ' + token, 'Version': '2021-07-28' }
          });
        }
        var invData = await invResp.json();
        var invoices = (invData.data && invData.data.invoices) || invData.invoices || invData.data || [];
        console.log('[/api/pay GET] invoices found:', invoices.length);
        if (invoices.length > 0) {
          var inv = invoices[0]; // most recent unpaid invoice
          // GHL invoice amounts: total is in the currency (JMD for JMD invoices)
          var rawTotal = inv.total || inv.amountDue || inv.amount || 0;
          amountJMD = parseFloat(rawTotal) || 0;
          description = inv.title || inv.name || 'Invoice ' + (inv.invoiceNumber || '');
          contactId = (inv.contactDetails && inv.contactDetails.id) || inv.contactId || '';
          entityId = inv._id || inv.id || '';
          console.log('[/api/pay GET] invoice:', entityId, 'amount:', amountJMD, 'desc:', description);
        }
      } catch (e) {
        console.error('[/api/pay GET] invoice lookup error:', e.message);
      }
    }

    if (amountJMD >= 80) {
      // Create HandyPay session and redirect immediately
      var session = await createHandyPaySession(
        cfg.handypay_api_key, amountJMD, description,
        { contact_id: contactId, location_id: locationId, entity_id: entityId, payment_type: 'ghl_native' }, true
      );
      var sessionId = session.id || session.sessionId || session.session_id;
      var checkoutUrl = session.url || session.checkout_url || session.checkoutUrl;
      await pool.query(
        `INSERT INTO payment_logs (session_id,location_id,contact_id,amount,currency,status,payment_type,checkout_url)
         VALUES ($1,$2,$3,$4,'JMD','pending','ghl_native',$5)
         ON CONFLICT (session_id) DO UPDATE SET checkout_url=$5,updated_at=NOW()`,
        [sessionId, locationId, contactId, Math.round(amountJMD), checkoutUrl]
      );
      console.log('[/api/pay GET] serving open-tab page:', sessionId, amountJMD);
      var cu = checkoutUrl, sid = sessionId, amt = amountJMD;
      var openHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandyPay</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f4f6fb;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}.card{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.09);padding:28px;max-width:380px;width:100%;text-align:center}.logo{font-size:36px;margin-bottom:10px}h2{color:#D10039;font-size:18px;font-weight:800;margin-bottom:4px}.amt{font-size:28px;font-weight:900;color:#1a1a1a;margin:12px 0}.lbl{font-size:12px;color:#888;margin-bottom:16px}.btn{width:100%;background:#D10039;color:#fff;border:none;border-radius:9px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:10px}.btn:disabled{background:#ccc}.st{font-size:13px;color:#555;margin-top:6px}</style></head>
<body><div class="card"><div class="logo">&#x1F4B3;</div><h2>HandyPay</h2>
<div class="amt">J${ amt.toLocaleString() }</div>
<div class="lbl">Invoice Payment</div>
<button class="btn" id="btn" onclick="openHP()">Open HandyPay Checkout</button>
<div class="st" id="st">Click above to complete your payment</div>
</div>
<script>
var URL=\`${ cu }\`, SID=\`${ sid }\`, done=false;
function openHP(){
  if(done)return; done=true;
  document.getElementById('btn').disabled=true;
  document.getElementById('st').textContent='Opening HandyPay...';
  var w=window.open(URL,'_blank','noopener');
  if(!w){document.getElementById('st').textContent='Popup blocked. Click below:';document.getElementById('btn').disabled=false;done=false;return;}
  document.getElementById('st').textContent='HandyPay opened in new tab. Complete payment there, then return.';
  // Poll DB every 3s to check if payment completed
  var poll=setInterval(function(){
    fetch('/api/query?paymentIntentId='+SID).then(function(r){return r.json();}).then(function(d){
      if(d.status==='succeeded'){
        clearInterval(poll);
        document.getElementById('st').textContent='Payment confirmed! ✅';
        window.parent.postMessage({type:'PAYMENT_SUCCESS',paymentIntentId:SID,status:'succeeded'},'*');
        window.parent.postMessage({event:'payment-success',paymentIntentId:SID},'*');
      }
    }).catch(function(){});
  },3000);
}
// Auto-open after 1s
setTimeout(openHP,1000);
// Also listen for postMessage from success page (if window.open worked)
window.addEventListener('message',function(e){
  var d=e.data||{};
  if(d.paymentIntentId||d.type==='PAYMENT_SUCCESS'){
    window.parent.postMessage({type:'PAYMENT_SUCCESS',paymentIntentId:d.paymentIntentId||SID,status:'succeeded'},'*');
    document.getElementById('st').textContent='Payment confirmed! ✅';
  }
});
</script></body></html>`;
      res.setHeader('Content-Type','text/html');
      return res.send(openHtml);
    }

    // Fallback: show manual input page (amount unknown)
    var locId = locationId;
    var html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandyPay</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f4f6fb;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}.card{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.09);padding:28px;max-width:380px;width:100%}.logo{font-size:32px;text-align:center;margin-bottom:10px}h2{color:#D10039;font-size:17px;font-weight:800;text-align:center;margin-bottom:12px}label{display:block;font-size:13px;font-weight:700;color:#333;margin-bottom:4px}input{width:100%;border:1.5px solid #ccc;border-radius:8px;padding:10px;font-size:16px;margin-bottom:12px;outline:none}input:focus{border-color:#D10039}.btn{width:100%;background:#D10039;color:#fff;border:none;border-radius:9px;padding:13px;font-size:15px;font-weight:700;cursor:pointer}.status{font-size:12px;color:#888;text-align:center;margin-top:8px}.err{color:#b91c1c}</style>
</head>
<body><div class="card"><div class="logo">&#x1F4B3;</div><h2>HandyPay</h2>
<label>Amount (JMD)</label>
<input type="number" id="amt" placeholder="e.g. 2000" min="80" step="1" autofocus>
<button class="btn" onclick="pay()">Pay with HandyPay</button>
<div class="status" id="st"></div>
</div>
<script>
var L="${ locId }",done=false;
function pay(){
  if(done)return;
  var a=parseFloat(document.getElementById('amt').value)||0;
  if(a<80){document.getElementById('st').textContent='Min J$80';document.getElementById('st').className='status err';return;}
  done=true;document.getElementById('st').textContent='Creating session...';
  fetch('/api/create-native-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({locationId:L,amountJMD:a,description:'Invoice Payment'})})
  .then(function(r){return r.json();})
  .then(function(d){
    if(d.checkoutUrl){
      var sid=d.sessionId||d.paymentIntentId||'';
      document.getElementById('st').textContent='Opening HandyPay...';
      var w=window.open(d.checkoutUrl,'_blank');
      if(!w){document.getElementById('st').textContent='Popup blocked — click: <a href="'+d.checkoutUrl+'" target="_blank">Open HandyPay</a>';done=false;document.getElementById('btn').disabled=false;return;}
      document.getElementById('st').textContent='HandyPay opened in new tab. Return here after paying.';
      if(sid){var poll=setInterval(function(){fetch('/api/query?paymentIntentId='+sid).then(function(r){return r.json();}).then(function(qd){if(qd.status==='succeeded'){clearInterval(poll);document.getElementById('st').textContent='Payment confirmed! ✅';window.parent.postMessage({type:'PAYMENT_SUCCESS',paymentIntentId:sid,status:'succeeded'},'*');}}).catch(function(){});},3000);}
    }else{document.getElementById('st').textContent='Error: '+(d.error||'?');document.getElementById('st').className='status err';done=false;}
  })
  .catch(function(e){document.getElementById('st').textContent='Error: '+e.message;done=false;});
}
</script>
</body></html>`;
    res.setHeader('Content-Type','text/html');
    return res.send(html);
  } catch (e) {
    console.error('[/api/pay GET] CRASH:', e.message);
    return res.status(500).send('<h2>HandyPay Error: ' + e.message + '</h2>');
  }
});

app.post('/api/create-native-session', async (req, res) => {
  try {
    var locationId=req.body.locationId, amountJMD=parseFloat(req.body.amountJMD)||0;
    var description=req.body.description||'Invoice Payment', contactId=req.body.contactId||'', entityId=req.body.entityId||'';
    console.log('[create-native-session]',locationId,amountJMD);
    if(!locationId||amountJMD<80) return res.status(400).json({error:'Need locationId+amountJMD>=80. Got:'+amountJMD});
    var cfg=await getMerchantConfig(locationId);
    if(!cfg||!cfg.handypay_api_key) return res.status(400).json({error:'Not configured: '+locationId});
    var session=await createHandyPaySession(cfg.handypay_api_key,amountJMD,description,
      {contact_id:contactId,location_id:locationId,entity_id:entityId,payment_type:'ghl_native'},true);
    var sessionId=session.id||session.sessionId||session.session_id;
    var checkoutUrl=session.url||session.checkout_url||session.checkoutUrl;
    await pool.query(
      `INSERT INTO payment_logs (session_id,location_id,contact_id,amount,currency,status,payment_type,checkout_url)
       VALUES ($1,$2,$3,$4,'JMD','pending','ghl_native',$5)
       ON CONFLICT (session_id) DO UPDATE SET checkout_url=$5,updated_at=NOW()`,
      [sessionId,locationId,contactId,Math.round(amountJMD),checkoutUrl]
    );
    console.log('[create-native-session] ok:',sessionId);
    return res.json({sessionId,checkoutUrl,paymentIntentId:sessionId});
  } catch(e){
    console.error('[create-native-session] ERR:',e.message);
    return res.status(500).json({error:e.message});
  }
});

// ============================================================
// DEBUG MESSAGE CAPTURE (postMessages from GHL iframe)
// ============================================================
app.post('/api/debug-message', async (req, res) => {
  try {
    await pool.query('INSERT INTO debug_messages (location_id,message,origin) VALUES ($1,$2,$3)',
      [req.body.locationId||'',JSON.stringify(req.body.message||{}),req.body.origin||'']).catch(function(){});
    return res.json({ok:true});
  } catch(e){return res.json({ok:false});}
});

app.get('/api/debug-messages', async (req, res) => {
  if(req.query.secret!==process.env.INIT_SECRET) return res.status(403).json({error:'Forbidden'});
  try {
    var rows=(await pool.query('SELECT * FROM debug_messages ORDER BY created_at DESC LIMIT 20')).rows;
    return res.json({count:rows.length,messages:rows});
  } catch(e){return res.json({error:e.message,note:'Run /api/init-db first'});}
});


app.post('/api/re-register', async (req, res) => {
  if (req.query.secret !== process.env.INIT_SECRET) return res.status(403).json({ error: 'forbidden' });
  var locationId = req.query.locationId;
  if (!locationId) return res.status(400).json({ error: 'Missing locationId' });
  var cfg = await getMerchantConfig(locationId);
  if (!cfg) return res.status(404).json({ error: 'Location not found in DB' });
  var token = cfg.crm_access_token;
  if (!token) {
    try { token = await refreshCrmToken(locationId); } catch(e) { return res.status(400).json({ error: 'No CRM token: ' + e.message }); }
  }
  var result = await registerPaymentProvider(locationId, token);
  var result2 = await activatePaymentModes(locationId, token, cfg.handypay_api_key || 'hp_pending_setup', cfg.mode || 'test');
  return res.json({ ok: true, register: result, activate: result2 });
});



module.exports = app;
