const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const app = express();

// PASTE CHECK: if copied from chat, verify GHL_API, GHL_CLIENT_ID, GHL_CLIENT_SECRET are NOT corrupted
const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_CLIENT_ID = process.env.GHL_CLIENT_ID;
const GHL_CLIENT_SECRET = process.env.GHL_CLIENT_SECRET;
const HP_BASE = 'https://api.handypay.me/api/v1';
const APP_URL = process.env.APP_URL || 'https://handypay-deposits-app.vercel.app';
const LOGO_URL = 'https://storage.googleapis.com/crm-conversations-ai-production/ask-ai-images/1785549533996/aaf88bbe-7f89-44b6-ba1b-12a6417755f6.png';

app.use('/api/webhooks', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Universal request logger - saves all requests to debug_messages for debugging
app.use(function(req, res, next) {
  if (req.path === '/api/debug-messages' || req.path === '/api/health') return next();
  pool.query('INSERT INTO debug_messages (location_id, message, origin) VALUES ($1, $2, $3)',
    ['req-log', JSON.stringify({ method: req.method, path: req.path, query: req.query, body: req.method === 'POST' ? req.body : undefined, ua: (req.headers['user-agent']||'').substring(0,80), ip: req.ip }), 'request-logger']
  ).catch(function(){});
  next();
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ============================================================
// HEALTH
// ============================================================
app.get('/', (req, res) => res.json({ status: 'ok', service: 'HandyPay Deposits v2.0' }));
// ============================================================
// SUCCESS / CANCEL PAGES
// ============================================================
app.get('/success', async (req, res) => {
  var sessionId = req.query.session_id || req.query.sessionId || '';
  // Server-side: mark payment as paid + call GHL record-payment
  if (sessionId) {
    try {
      await updatePaymentLogStatus(sessionId, 'paid');
      var sLog = await getPaymentLogBySession(sessionId);
      if (sLog && sLog.appointment_id && sLog.location_id) {
        var sCfg = await getMerchantConfig(sLog.location_id).catch(function(){return null;});
        if (sCfg && (sCfg.ghl_access_token || sCfg.crm_access_token)) {
          var sTok = sCfg.crm_access_token || sCfg.ghl_access_token;
          try { var sRef = await refreshCrmToken(sLog.location_id); if (sRef && sRef.access_token) sTok = sRef.access_token; } catch(e2){}
          fetch(GHL_API + '/invoices/' + sLog.appointment_id + '/record-payment', {
            method: 'POST', headers: { 'Authorization': 'Bearer ' + sTok, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
            body: JSON.stringify({ altId: sLog.location_id, altType: 'location', amount: sLog.amount, mode: 'card', notes: 'HandyPay:' + sessionId })
          }).then(function(rp){ console.log('[/success] record-payment', sLog.appointment_id, rp.status); }).catch(function(e3){ console.error('[/success] record-payment err', e3.message); });
        }
      }
    } catch(sErr) { console.error('[/success] err:', sErr.message); }
  }
  res.setHeader('Content-Type', 'text/html');
  var sid = JSON.stringify(sessionId);
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Confirmed</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0fdf4;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;width:100%;padding:40px;text-align:center}.icon{font-size:64px;margin-bottom:16px}h1{font-size:22px;font-weight:800;color:#15803d;margin-bottom:10px}p{font-size:15px;color:#555;line-height:1.6}.sub{font-size:13px;color:#888;margin-top:20px}</style></head><body><div class="card"><div class="icon">&#x2705;</div><h1>Payment Confirmed!</h1><p>Thank you. Your payment was received successfully.</p><p class="sub">You may close this window.</p></div><script>var s='+sid+';if(s){try{window.parent.postMessage({type:"PAYMENT_SUCCESS",paymentIntentId:s,status:"succeeded"},"*");window.parent.postMessage({event:"payment-success",paymentIntentId:s},"*");if(window.opener){window.opener.postMessage({type:"PAYMENT_SUCCESS",paymentIntentId:s,status:"succeeded"},"*");}window.parent.postMessage({success:true,paymentIntentId:s,orderId:s},"*");}catch(e){}}setTimeout(function(){try{window.parent.postMessage({type:"PAYMENT_COMPLETE",paymentIntentId:s},"*");}catch(e){}},2000);<\/script></body></html>');
});

app.get('/cancel', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Cancelled</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#fff7f7;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;width:100%;padding:40px;text-align:center}.icon{font-size:64px;margin-bottom:16px}h1{font-size:22px;font-weight:800;color:#b91c1c;margin-bottom:10px}p{font-size:15px;color:#555;line-height:1.6}.sub{font-size:13px;color:#888;margin-top:20px}</style></head><body><div class="card"><div class="icon">\u274C</div><h1>Payment Cancelled</h1><p>Your payment was not completed. Your appointment spot is not yet secured.</p><p>Please use the link in your SMS to try again.</p><p class="sub">You can close this window.</p></div></body></html>');
});

app.get('/p/:code', async (req, res) => {
  var sc = req.params.code;
  try {
    var row = (await pool.query('SELECT full_url FROM short_links WHERE code=$1', [sc])).rows[0];
    if(!row) return res.status(404).send('<h2 style="font-family:sans-serif;margin:40px">Link not found or expired.</h2>');
    pool.query('UPDATE short_links SET clicks=clicks+1 WHERE code=$1', [sc]).catch(function(){});
    return res.redirect(302, row.full_url);
  } catch(e) { return res.status(500).send('Error: '+e.message); }
});

app.get('/api/logs', async (req, res) => {
  if(req.query.secret !== process.env.INIT_SECRET) return res.status(403).json({error:'forbidden'});
  var rows = (await pool.query('SELECT session_id,contact_id,location_id,amount,payment_type,status,created_at FROM payment_logs ORDER BY created_at DESC LIMIT 20')).rows;
  res.json({ count: rows.length, logs: rows });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.get('/api/logo', (req, res) => res.redirect(LOGO_URL));

// ============================================================
// DB HELPERS
// ============================================================
async function getMerchantConfig(locationId) {
  const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [locationId]);
  return rows[0] || null;
}
async function getPaymentLogBySession(sessionId) {
  const { rows } = await pool.query('SELECT * FROM payment_logs WHERE session_id=$1', [sessionId]);
  return rows[0] || null;
}
async function updatePaymentLogStatus(sessionId, status) {
  await pool.query('UPDATE payment_logs SET status=$1, updated_at=NOW() WHERE session_id=$2', [status, sessionId]);
}

// ============================================================
// CRM HELPERS
// ============================================================
async function getContact(accessToken, contactId) {
  const r = await fetch(GHL_API + '/contacts/' + contactId, {
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Version': '2021-07-28' }
  });
  if (!r.ok) throw new Error('getContact ' + r.status);
  const d = await r.json();
  return d.contact || d;
}

async function refreshCrmToken(locationId) {
  const cfg = await getMerchantConfig(locationId);
  var refreshTok = (cfg && cfg.crm_refresh_token) || (cfg && cfg.ghl_refresh_token) || '';
  if (!cfg || !refreshTok) throw new Error('No refresh token');
  const r = await fetch(GHL_API + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GHL_CLIENT_ID, client_secret: GHL_CLIENT_SECRET,
      grant_type: 'refresh_token', refresh_token: refreshTok
    })
  });
  if (!r.ok) throw new Error('Token refresh ' + r.status);
  const data = await r.json();
  await pool.query(
    'UPDATE merchant_configs SET crm_access_token=$1, crm_refresh_token=$2, ghl_access_token=$1, ghl_refresh_token=$2, updated_at=NOW() WHERE location_id=$3',
    [data.access_token, data.refresh_token, locationId]
  );
  return data.access_token;
}

async function sendSms(accessToken, locationId, contactId, message) {
  let conversationId;
  const sr = await fetch(GHL_API + '/conversations/search?contactId=' + contactId + '&locationId=' + locationId, {
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Version': '2021-04-15' }
  });
  if (sr.ok) {
    const sd = await sr.json();
    conversationId = sd.conversations && sd.conversations[0] && sd.conversations[0].id;
  }
  if (!conversationId) {
    const cr = await fetch(GHL_API + '/conversations', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
      body: JSON.stringify({ contactId: contactId, locationId: locationId })
    });
    const cd = await cr.json();
    conversationId = (cd.conversation && cd.conversation.id) || cd.id;
  }
  if (!conversationId) throw new Error('Could not get/create conversation');
  const mr = await fetch(GHL_API + '/conversations/messages', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
    body: JSON.stringify({ type: 'TYPE_WHATSAPP', message: message, conversationId: conversationId, contactId: contactId })
  });
  if (!mr.ok) {
    const errText = await mr.text();
    throw new Error('SMS send ' + mr.status + ' ' + errText);
  }
  return mr.json();
}

async function addContactTag(accessToken, contactId, tags) {
  const r = await fetch(GHL_API + '/contacts/' + contactId + '/tags', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
    body: JSON.stringify({ tags: tags })
  });
  if (!r.ok) console.error('[tag] failed:', r.status);
  return r.json().catch(function() {});
}

async function addContactNote(accessToken, contactId, body) {
  const r = await fetch(GHL_API + '/contacts/' + contactId + '/notes', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
    body: JSON.stringify({ body: body })
  });
  if (!r.ok) console.error('[note] failed:', r.status);
  return r.json().catch(function() {});
}

// ============================================================
// SHORT LINK HELPERS
// ============================================================
function generateCode() {
  var c = 'abcdefghjkmnpqrstuvwxyz23456789';
  var code = ''; for(var i=0;i<6;i++) code += c[Math.floor(Math.random()*c.length)];
  return code;
}
async function createShortLink(fullUrl, sessionId, locationId, contactId, paymentType) {
  for(var attempt=0; attempt<10; attempt++) {
    var sc = generateCode();
    try {
      await pool.query('INSERT INTO short_links (code,full_url,session_id,location_id,contact_id,payment_type) VALUES ($1,$2,$3,$4,$5,$6)',
        [sc, fullUrl, sessionId, locationId, contactId, paymentType]);
      return APP_URL + '/p/' + sc;
    } catch(e) { if((e.code||'') !== '23505') throw e; }
  }
  return fullUrl; // fallback to full URL if all codes collide
}

// ============================================================
// HANDYPAY HELPERS
// ============================================================
async function createHandyPaySession(apiKey, amountJMD, label, meta, passFeesToCustomer) {
  var payload = {
    line_items: [{ amount: Math.round(amountJMD) * 100, currency: 'jmd', name: label, quantity: 1 }],
    mode: 'payment',
    success_url: APP_URL + '/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: APP_URL + '/cancel',
    pass_fees_to_customer: passFeesToCustomer !== false,
    metadata: meta
  };
  var r = await fetch(HP_BASE + '/payment-sessions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  var text = await r.text();
  console.log('[HandyPay]', r.status, text.substring(0, 200));
  if (!r.ok) throw new Error('HandyPay ' + r.status + ': ' + text);
  var parsed = JSON.parse(text);
  return parsed.data || parsed;
}

// PAYMENT PROVIDER REGISTRATION
// ============================================================
async function registerPaymentProvider(locationId, accessToken) {
  try {
    var r = await fetch(GHL_API + '/payments/custom-provider/provider?locationId=' + locationId, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
      body: JSON.stringify({
        name: 'HandyPay Deposits',
        description: 'Collect booking deposits automatically via SMS payment link.',
        paymentsUrl: APP_URL + '/api/pay?locationId=' + locationId,
        queryUrl: APP_URL + '/api/query',
        imageUrl: LOGO_URL,
        supportsSubscriptionSchedule: false
      })
    });
    var d = await r.json();
    console.log('[register]', locationId, r.status, JSON.stringify(d).substring(0, 200));
    return d;
  } catch (e) { console.error('[register]', e.message); }
}

async function activatePaymentModes(locationId, accessToken, apiKey, mode) {
  var key = apiKey || 'hp_pending_setup';
  try {
    var r = await fetch(GHL_API + '/payments/custom-provider/connect?locationId=' + locationId, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
      body: JSON.stringify({
        locationId: locationId,
        live: { apiKey: key, publishableKey: key, liveMode: mode === 'live' },
        test: { apiKey: key, publishableKey: key, liveMode: false }
      })
    });
    var d = await r.json();
    console.log('[activate]', locationId, mode, r.status, JSON.stringify(d).substring(0, 200));
    return d;
  } catch (e) { console.error('[activate]', e.message); }
}


// ============================================================
// HANDYPAY WEBHOOK REGISTRATION (per sub-account)
// ============================================================
async function registerHandyPayWebhook(apiKey, locationId) {
  try {
    var cfg = await getMerchantConfig(locationId);
    if (cfg && cfg.handypay_webhook_id) {
      await fetch(HP_BASE + '/webhook-endpoints/' + cfg.handypay_webhook_id, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + apiKey }
      }).catch(function() {});
    }
    var r = await fetch(HP_BASE + '/webhook-endpoints', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: APP_URL + '/api/webhooks/handypay',
        events: ['checkout.session.completed', 'checkout.session.expired']
      })
    });
    var d = await r.json();
    if (d.success && d.data) {
      await pool.query(
        'UPDATE merchant_configs SET handypay_webhook_id=$1, handypay_webhook_secret=$2, updated_at=NOW() WHERE location_id=$3',
        [d.data.id, d.data.secret, locationId]
      );
      console.log('[webhook-register]', locationId, d.data.id, 'active:', d.data.isActive);
      return d.data;
    }
    console.error('[webhook-register] failed:', JSON.stringify(d));
  } catch (e) { console.error('[webhook-register]', e.message); }
}

// ============================================================
// OAUTH CALLBACK
// ============================================================
app.get('/api/oauth/callback', async (req, res) => {
  var code = req.query.code;
  if (!code) return res.status(400).send('Missing code');
  try {
    var t = await fetch(GHL_API + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GHL_CLIENT_ID, client_secret: GHL_CLIENT_SECRET,
        grant_type: 'authorization_code', code: code,
        redirect_uri: APP_URL + '/api/oauth/callback'
      })
    });
    var tokens = await t.json();
    if (!tokens.access_token) return res.status(400).send('Token error: ' + JSON.stringify(tokens));
    var locationId = tokens.locationId;
    if (!locationId) return res.send('<h2>Sub-Account Install Required</h2><p>Install per sub-account, not at agency level.</p>');
    await pool.query(
      'INSERT INTO merchant_configs (location_id,crm_access_token,crm_refresh_token) VALUES ($1,$2,$3) ON CONFLICT (location_id) DO UPDATE SET crm_access_token=$2,crm_refresh_token=$3,updated_at=NOW()',
      [locationId, tokens.access_token, tokens.refresh_token]
    );
    await registerPaymentProvider(locationId, tokens.access_token);
    await activatePaymentModes(locationId, tokens.access_token, 'hp_pending_setup', 'test');
    res.redirect('/api/settings?location_id=' + locationId + '&installed=true');
  } catch (err) { res.status(500).send('OAuth error: ' + err.message); }
});

// ============================================================
// SETTINGS
// ============================================================
app.get('/api/settings', async (req, res) => {
  var location_id = req.query.location_id;
  if (!location_id) {
    res.setHeader('Content-Type', 'text/html');
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>HandyPay Settings</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f4f6fb;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.09);max-width:440px;width:100%;padding:36px}h1{font-size:18px;font-weight:800;color:#005DBD;margin-bottom:16px}p{font-size:14px;color:#555;margin-bottom:20px}label{display:block;font-size:13px;font-weight:700;color:#333;margin-bottom:6px}input{width:100%;border:1.5px solid #e0e0e0;border-radius:8px;padding:10px 14px;font-size:14px;outline:none;margin-bottom:16px}.btn{width:100%;background:#D10039;color:#fff;border:none;border-radius:9px;padding:13px;font-size:15px;font-weight:700;cursor:pointer}</style></head><body><div class="card"><h1>HandyPay Settings</h1><p id="msg">Detecting your sub-account...</p><form id="form" style="display:none"><label>Location ID</label><input id="lid" placeholder="e.g. tPCmng9TJ7Qc6gG7AaU3"><button class="btn" type="submit">Open Settings</button></form><script>var ok=false;function go(id){if(ok)return;ok=true;localStorage.setItem("hp_lid",id);location.href="/api/settings?location_id="+id;}var s=localStorage.getItem("hp_lid");if(s){document.getElementById("msg").textContent="Loading...";setTimeout(function(){go(s);},300);}window.addEventListener("message",function(e){var d=e.data||{};var id=d.locationId||d.location_id;if(id)go(id);});try{window.parent.postMessage({type:"REQUEST_LOCATION",source:"handypay-deposits"},"*");}catch(e){}setTimeout(function(){if(!ok){document.getElementById("msg").textContent="Enter your Location ID:";document.getElementById("form").style.display="block";}},2500);document.getElementById("form").addEventListener("submit",function(e){e.preventDefault();var v=document.getElementById("lid").value.trim();if(v)go(v);})</script></div></body></html>');
  }
  var c = {};
  try {
    var rows = (await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [location_id])).rows;
    if (rows.length) c = rows[0];
  } catch (e) {}
  var msg = req.query.installed ? 'App installed! Enter your HandyPay API key to activate deposits.' : req.query.saved ? 'Settings saved. Deposits active.' : '';
  var isConn = c.handypay_api_key && c.handypay_api_key !== 'hp_pending_setup';
  var masked = isConn ? c.handypay_api_key.slice(0,14) + '...' + c.handypay_api_key.slice(-4) : '';
  var dep = c.deposit_amount || 5000;
  var curMode = c.mode || 'test';
  res.setHeader('Content-Type', 'text/html');
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>HandyPay Deposits</title>'
    + '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f4f6fb;padding:24px}.card{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.09);max-width:560px;margin:0 auto;padding:36px}.hdr{margin-bottom:22px;padding-bottom:18px;border-bottom:1px solid #f0f0f0}.hdr h1{font-size:20px;font-weight:800;color:#005DBD}.ok{background:#e8f5e9;border:1px solid #a5d6a7;color:#2e7d32;padding:12px;border-radius:8px;font-size:14px;margin-bottom:16px}.badge{background:#e3f2fd;color:#1565c0;padding:8px 14px;border-radius:8px;font-size:13px;margin-bottom:16px}label{display:block;font-size:13px;font-weight:700;color:#333;margin-top:14px;margin-bottom:4px}input,select,textarea{width:100%;border:1.5px solid #e0e0e0;border-radius:8px;padding:10px 14px;font-size:14px;outline:none}.hr{border:none;border-top:1px solid #f0f0f0;margin:18px 0}.flow{background:#f8f9ff;border:1px solid #e0e8ff;border-radius:10px;padding:14px;margin-top:16px;font-size:13px;color:#444;line-height:1.9}.btn{width:100%;margin-top:22px;background:#D10039;color:#fff;border:none;border-radius:9px;padding:14px;font-size:15px;font-weight:700;cursor:pointer}.foot{margin-top:14px;text-align:center;font-size:11px;color:#ccc}</style></head>'
    + '<body><div class="card"><div class="hdr"><h1>HandyPay Deposits</h1><span style="font-size:12px;color:#999">Deposit Collection Settings</span></div>'
    + (msg ? '<div class="ok">' + msg + '</div>' : '')
    + (isConn ? '<div class="badge">Connected &middot; <code>' + masked + '</code> &middot; ' + curMode.toUpperCase() + '</div>' : '')
    + '<form method="POST" action="/api/settings"><input type="hidden" name="location_id" value="' + location_id + '">'
    + '<label>HandyPay API Key *</label><input type="text" name="handypay_api_key" value="' + (isConn ? c.handypay_api_key : '') + '" placeholder="hp_test_... or hp_live_..." required autocomplete="off">'
    + '<label>Mode</label><select name="mode"><option value="test"' + (curMode !== 'live' ? ' selected' : '') + '>Test Mode</option><option value="live"' + (curMode === 'live' ? ' selected' : '') + '>Live Mode</option></select>'
    + '<div class="hr"></div>'
    + '<label>Deposit Amount (whole JMD) *</label><input type="number" name="deposit_amount" value="' + dep + '" min="100" step="100" required>'
    + '<label>Custom SMS Template (optional)</label><textarea name="sms_template" rows="3" placeholder="Use {name} {amount} {date} {link}. Leave blank for default.">' + (c.sms_template || '') + '</textarea>'
    + '<div class="flow"><strong>How deposits work:</strong><br>1. Client books in your calendar<br>2. They get an SMS with a HandyPay payment link<br>3. Client pays &rarr; appointment confirmed<br>4. Contact tagged deposit-paid + note added</div>'
    + '<button type="submit" class="btn">Save &amp; Activate HandyPay</button></form>'
    + '<div class="foot">HandyPay Deposits v2.0 &middot; L-NET Smart Technologies</div></div></body></html>');
});

app.post('/api/settings', async (req, res) => {
  var location_id = req.body.location_id;
  var handypay_api_key = req.body.handypay_api_key;
  var deposit_amount = req.body.deposit_amount;
  var mode = req.body.mode;
  var sms_template = req.body.sms_template;
  if (!location_id) return res.status(400).send('Missing location_id');
  try {
    await pool.query(
      'INSERT INTO merchant_configs (location_id,handypay_api_key,deposit_amount,mode,sms_template,updated_at) VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (location_id) DO UPDATE SET handypay_api_key=$2,deposit_amount=$3,mode=$4,sms_template=$5,updated_at=NOW()',
      [location_id, handypay_api_key, parseInt(deposit_amount) || 5000, mode || 'test', sms_template || '']
    );
    var rows = (await pool.query('SELECT crm_access_token FROM merchant_configs WHERE location_id=$1', [location_id])).rows;
    if (rows[0] && rows[0].crm_access_token) {
      await registerPaymentProvider(location_id, rows[0].crm_access_token);
      await activatePaymentModes(location_id, rows[0].crm_access_token, handypay_api_key, mode || 'test');
      await activatePaymentModes(location_id, rows[0].crm_access_token, handypay_api_key, mode || 'test');
    }
    await registerHandyPayWebhook(handypay_api_key, location_id);
    res.redirect('/api/settings?location_id=' + location_id + '&saved=true');
  } catch (err) {
    console.error('[settings POST]', err);
    res.status(500).send('Error: ' + err.message);
  }
});

// ============================================================
// CRM APPOINTMENT WEBHOOK  <-- THE DEPOSIT TRIGGER
// ============================================================
app.post('/api/webhooks/crm', async (req, res) => {
  var rawBody = req.body; var body;
  try { body = typeof rawBody==='string' ? JSON.parse(rawBody) : (Buffer.isBuffer(rawBody) ? JSON.parse(rawBody.toString()) : rawBody); } catch(e) { body = rawBody; }
  console.log('[CRM Webhook]', JSON.stringify(body));
  var locationId = body.locationId||(body.customData&&body.customData.locationId);
  var contactId  = body.contactId ||(body.customData&&body.customData.contactId);
  var contactName= body.contactName||(body.customData&&body.customData.contactName)||'there';
  var startTime  = body.startTime  ||(body.customData&&body.customData.startTime);
  var title      = body.title      ||(body.customData&&body.customData.title)||'appointment';
  var appointmentTotal = parseFloat(body.appointmentTotal||(body.customData&&body.customData.appointmentTotal)||0);
  if(!locationId||!contactId) return res.json({ok:false,error:'missing_fields'});
  var config = await getMerchantConfig(locationId);
  if(!config) return res.json({ok:false,error:'no_config'});
  var token = config.crm_access_token;
  if(!token) return res.json({ok:false,error:'no_token'});
  var contact;
  try { contact = await getContact(token, contactId); }
  catch(e) {
    console.log('[getContact] failed, trying token refresh:', e.message);
    try {
      token = await refreshCrmToken(locationId);
      // Update token in DB
      await pool.query('UPDATE merchant_configs SET crm_access_token=$1, updated_at=NOW() WHERE location_id=$2', [token, locationId]);
      contact = await getContact(token, contactId);
    } catch(e2) { console.error('[getContact after refresh]',e2.message); return res.json({ok:false,error:'contact_fetch_failed'}); }
  }
  if(!contact||!contact.phone) return res.json({ok:false,error:'no_phone'});
  var pct = config.deposit_percentage || 30;
  var hasTotal = appointmentTotal > 0;
  var depositAmt = hasTotal ? Math.round(appointmentTotal * pct / 100) : (config.deposit_amount || 0);
  var fullAmt = appointmentTotal;
  var firstName = contactName.split(' ')[0];
  var dateStr = (function(iso){ if(!iso) return 'your appointment'; try{ return new Date(iso).toLocaleString('en-US',{weekday:'long',month:'long',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}); } catch(e){ return iso; } })(startTime);
  var appointmentId = body.appointmentId||(body.customData&&body.customData.appointmentId)||'';
  var meta = { locationId:locationId, contactId:contactId, title:title, startTime:startTime, appointmentId:appointmentId };
  var depositSession, fullSession, smsMessage;
  try {
    if(hasTotal) {
      var sessions = await Promise.all([
        createHandyPaySession(config.handypay_api_key, depositAmt, pct+'% Deposit - '+title, Object.assign({},meta,{paymentType:'deposit'})),
        createHandyPaySession(config.handypay_api_key, fullAmt, 'Full Payment - '+title, Object.assign({},meta,{paymentType:'full'}))
      ]);
      depositSession = sessions[0]; fullSession = sessions[1];
      var dLink = await createShortLink(depositSession.url, depositSession.id, locationId, contactId, 'deposit');
      var fLink = await createShortLink(fullSession.url,    fullSession.id,    locationId, contactId, 'full');
      smsMessage = 'Hi '+firstName+'! '+title+' booked for '+dateStr+'.\n\n'+
        'Confirm your spot with payment:\n\n'+
        '\uD83D\uDCB3 Deposit ('+pct+'%) - JMD $'+depositAmt.toLocaleString()+'\n'+dLink+'\n\n'+
        '\u2705 Pay in full - JMD $'+fullAmt.toLocaleString()+'\n'+fLink+'\n\n'+
        'Links good for 24 hours.';
    } else {
      depositSession = await createHandyPaySession(config.handypay_api_key, depositAmt, 'Deposit - '+title, Object.assign({},meta,{paymentType:'deposit'}));
      var dLink = await createShortLink(depositSession.url, depositSession.id, locationId, contactId, 'deposit');
      smsMessage = 'Hi '+firstName+'! '+title+' booked for '+dateStr+'.\n\nPay deposit to confirm your spot:\n\n'+
        '\uD83D\uDCB3 JMD $'+depositAmt.toLocaleString()+'\n'+dLink+'\n\nLink good for 24 hours.';
    }
  } catch(err) {
    console.error('[HandyPay]',err.message);
    return res.status(500).json({ok:false,error:'handypay_failed',detail:err.message});
  }
  try {
    await pool.query('INSERT INTO payment_logs (session_id,contact_id,location_id,appointment_id,amount,currency,status,access_token,payment_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (session_id) DO NOTHING',
      [depositSession.id,contactId,locationId,title,depositAmt,'jmd','pending',token,'deposit']);
    if(fullSession) await pool.query('INSERT INTO payment_logs (session_id,contact_id,location_id,appointment_id,amount,currency,status,access_token,payment_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (session_id) DO NOTHING',
      [fullSession.id,contactId,locationId,title,fullAmt,'jmd','pending',token,'full']);
  } catch(err){ console.error('[DB]',err.message); }
  var smsStatus = 'failed';
  try { await sendSms(token,locationId,contactId,smsMessage); smsStatus='sent'; } catch(err){ console.error('[SMS]',err.message); }
  res.json({ok:true,depositSessionId:depositSession.id,fullSessionId:fullSession?fullSession.id:null,smsStatus:smsStatus});
});
app.post('/api/webhooks/followup', async (req, res) => {
  var b = req.body;
  var locationId   = b.locationId   ||(b.customData&&b.customData.locationId);
  var contactId    = b.contactId    ||(b.customData&&b.customData.contactId);
  var contactName  = b.contactName  ||(b.customData&&b.customData.contactName)  ||'there';
  var startTime    = b.startTime    ||(b.customData&&b.customData.startTime);
  var title        = b.title        ||(b.customData&&b.customData.title)        ||'appointment';
  var followupNum  = parseInt(b.followupNum||(b.customData&&b.customData.followupNum)||1);
  if(!locationId||!contactId) return res.json({ok:false,error:'missing_fields'});
  var config = await getMerchantConfig(locationId);
  if(!config||!config.crm_access_token) return res.json({ok:false,error:'no_config'});
  var token = config.crm_access_token;
  // Look up existing pending short links for this contact
  var links = (await pool.query(
    'SELECT code, payment_type, created_at FROM short_links WHERE contact_id=$1 AND location_id=$2 ORDER BY created_at DESC LIMIT 10',
    [contactId, locationId]
  )).rows;
  var depositLink = '', fullLink = '', fresh = false;
  var cutoff = new Date(Date.now() - 23*60*60*1000); // 23 hours ago
  var depRow  = links.find(function(r){ return r.payment_type==='deposit' && new Date(r.created_at) > cutoff; });
  var fullRow = links.find(function(r){ return r.payment_type==='full'    && new Date(r.created_at) > cutoff; });
  if(depRow && fullRow) {
    depositLink = APP_URL + '/p/' + depRow.code;
    fullLink    = APP_URL + '/p/' + fullRow.code;
  } else {
    // Links expired - generate new sessions
    fresh = true;
    try {
      var pct = config.deposit_percentage || 30;
      var total = parseFloat(b.appointmentTotal||(b.customData&&b.customData.appointmentTotal)||0);
      var depAmt = total > 0 ? Math.round(total*pct/100) : (config.deposit_amount||0);
      var fullAmt = total;
      var meta = { locationId:locationId, contactId:contactId, title:title, startTime:startTime, paymentType:'deposit' };
      var ds = await createHandyPaySession(config.handypay_api_key, depAmt, pct+'% Deposit - '+title, Object.assign({},meta,{paymentType:'deposit'}));
      var fs = total > 0 ? await createHandyPaySession(config.handypay_api_key, fullAmt, 'Full Payment - '+title, Object.assign({},meta,{paymentType:'full'})) : null;
      depositLink = await createShortLink(ds.url, ds.id, locationId, contactId, 'deposit');
      fullLink    = fs ? await createShortLink(fs.url, fs.id, locationId, contactId, 'full') : '';
    } catch(e) { console.error('[followup] session error:', e.message); return res.json({ok:false,error:'session_failed'}); }
  }
  var firstName = contactName.split(' ')[0];
  var dateStr = (function(iso){ if(!iso) return 'your appointment'; try{ return new Date(iso).toLocaleString('en-US',{weekday:'long',month:'long',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}); }catch(e){return iso;} })(startTime);
  var msg;
  if(followupNum === 1) {
    msg = firstName+', your '+title+' on '+dateStr+' is not confirmed yet.\n\nYour spot is still open. Pay now:\n\n'+
      '\uD83D\uDCB3 Deposit:\n'+depositLink+(fullLink ? '\n\n\u2705 Full payment:\n'+fullLink : '');
  } else {
    msg = firstName+', last chance. '+title+' on '+dateStr+' - payment still pending.\n\nYour slot gets released if not paid today.\n\n'+
      '\uD83D\uDCB3 '+depositLink+(fullLink ? '\n\u2705 '+fullLink : '');
  }
  try { await sendSms(token, locationId, contactId, msg); } catch(e){ console.error('[followup SMS]',e.message); }
  res.json({ ok:true, followupNum:followupNum, fresh:fresh, depositLink:depositLink, fullLink:fullLink });
});
app.post('/api/webhooks/handypay', async (req, res) => {
  var rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
  var sig = req.headers['x-handypay-signature'] || '';
  var event;
  try { event = JSON.parse(rawBody.toString()); }
  catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  if (sig) {
    var locId = (event.data && event.data.metadata && event.data.metadata.locationId) || null;
    if (locId) {
      var sigCfg = await getMerchantConfig(locId).catch(function() { return null; });
      var whSecret = sigCfg && sigCfg.handypay_webhook_secret;
      if (whSecret && sig.startsWith('sha256=')) {
        var hexSig = sig.slice(7);
        var expected = crypto.createHmac('sha256', whSecret).update(rawBody).digest('hex');
        try {
          if (!crypto.timingSafeEqual(Buffer.from(hexSig, 'hex'), Buffer.from(expected, 'hex'))) {
            console.error('[sig-mismatch]', locId);
            return res.status(401).json({ error: 'Invalid signature' });
          }
        } catch (e) { return res.status(401).json({ error: 'Sig error' }); }
      }
    }
  }

  if (event.type === 'checkout.session.expired') {
    var expId = event.data && event.data.id;
    if (expId) { await updatePaymentLogStatus(expId, 'expired').catch(function(){}); }
    console.log('[hp-expired]', expId);
    return res.json({ ok: true, type: 'expired' });
  }

  var body = JSON.parse(rawBody.toString());
  var type = body.type;
  var data = body.data;
  console.log('[HP webhook] type:', type);

  var isPaid = ['payment.succeeded', 'checkout.session.completed', 'payment_intent.succeeded'].indexOf(type) !== -1;
  if (!isPaid) return res.json({ ok: true, skipped: type });

  var obj = (data && data.object) || data || {};
  var sessionId = obj.id || obj.session_id || body.id;
  var amountReceived = obj.amount_total || obj.amount || obj.amount_received;

  res.json({ ok: true });

  try {
    // Primary: read from session metadata (works even if DB log is missing)
    var contactId   = (obj.metadata && obj.metadata.contactId)   || null;
    var locationId  = (obj.metadata && obj.metadata.locationId)  || null;
    var payType2    = (obj.metadata && obj.metadata.paymentType) || 'deposit';
    var apptMetaId  = (obj.metadata && obj.metadata.appointmentId) || '';
    var amountJMD   = amountReceived ? Math.round(amountReceived / 100) : 0;
    var config2     = (contactId && locationId) ? await getMerchantConfig(locationId) : null;
    var accessToken = config2 && config2.crm_access_token;
    // Fallback: read from DB log if metadata missing
    var log = await getPaymentLogBySession(sessionId);
    if (!contactId || !accessToken) {
      if (!log) { console.error('[hp webhook] No metadata and no DB log for:', sessionId); return; }
      contactId   = contactId   || log.contact_id;
      locationId  = locationId  || log.location_id;
      accessToken = accessToken || log.access_token;
      payType2    = payType2 !== 'deposit' ? payType2 : (log.payment_type || 'deposit');
      apptMetaId  = apptMetaId || log.appointment_id || '';
      amountJMD   = amountJMD  || log.amount || 0;
    }
    var amount = amountJMD;
    var appointmentId = apptMetaId;

    var tagLabel = payType2 === 'full' ? 'paid-in-full' : 'deposit-paid';
    await addContactTag(accessToken, contactId, [tagLabel]);
    await addContactNote(accessToken, contactId,
      'Deposit Received\nAmount: JMD $' + ((amount || amountReceived || 0)).toLocaleString() + '\nSession: ' + sessionId + '\nAppointment: ' + (appointmentId || 'N/A') + '\nPowered by HandyPay'
    );
    await updatePaymentLogStatus(sessionId, 'paid');
    // Determine payment type (deposit or full)
    var payType = (obj.metadata && obj.metadata.paymentType) || (log && log.payment_type) || 'deposit';
    if(payType === 'full') { await addContactTag(accessToken, contactId, ['paid-in-full']); }
    // Confirm appointment in CRM so reminder workflows fire
    var apptCrmId = (obj.metadata && obj.metadata.appointmentId) || appointmentId || '';
    if(apptCrmId) {
      try {
        var ar = await fetch(GHL_API + '/calendars/events/appointments/' + apptCrmId, {
          method: 'PUT',
          headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
          body: JSON.stringify({ appointmentStatus: 'confirmed' })
        });
        var ad = await ar.json();
        console.log('[Confirm Appt]', apptCrmId, ar.status, JSON.stringify(ad).substring(0,100));
      } catch(e) { console.error('[Confirm Appt]', e.message); }
    }
    console.log('[hp webhook] Deposit confirmed | contact:', contactId, '| JMD', amount);
  } catch (err) {
    console.error('[hp webhook ERROR]', err.message);
  }
});

// ============================================================
// PAYMENT SUCCESS / CANCEL PAGES
// ============================================================
app.get('/api/payment-success', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Payment Confirmed</title><style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0fdf4;margin:0}.c{background:#fff;border-radius:16px;padding:40px;text-align:center;max-width:400px;box-shadow:0 4px 20px rgba(0,0,0,.08)}.i{font-size:56px;margin-bottom:16px}h1{color:#065f46;font-size:22px;margin-bottom:8px}p{color:#374151;font-size:15px;line-height:1.5}</style></head><body><div class="c"><div class="i">&#x2705;</div><h1>Deposit Paid!</h1><p>Your appointment is confirmed. You will receive a confirmation message shortly.</p><p style="margin-top:16px;font-size:12px;color:#9ca3af">Powered by HandyPay</p></div></body></html>');
});

app.get('/api/payment-cancel', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Payment Cancelled</title><style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fef2f2;margin:0}.c{background:#fff;border-radius:16px;padding:40px;text-align:center;max-width:400px;box-shadow:0 4px 20px rgba(0,0,0,.08)}.i{font-size:56px;margin-bottom:16px}h1{color:#991b1b;font-size:22px;margin-bottom:8px}p{color:#374151;font-size:15px;line-height:1.5}</style></head><body><div class="c"><div class="i">&#x274C;</div><h1>Payment Not Completed</h1><p>Your appointment has not been confirmed yet. Please contact us to complete your booking.</p></div></body></html>');
});

// ============================================================
// PAY + QUERY (for CRM payment provider engine)
// ============================================================
app.post('/api/pay', async (req, res) => {
  try {
    var body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
    console.log('[/api/pay POST] body:', JSON.stringify(body).substring(0, 400));
    // GHL sends altId (not locationId) and amountCents (in cents, not dollars)
    var locationId = body.altId || body.locationId || '';
    var amountCents = parseInt(body.amountCents) || 0;
    var amountJMD = amountCents / 100;
    var contactId = body.contactId || body.contact_id || '';
    var entityId = body.entityId || body.invoiceId || '';
    var description = body.description || body.entityType || 'Invoice Payment';
    console.log('[/api/pay POST] locationId:', locationId, 'amountCents:', amountCents, 'amountJMD:', amountJMD);
    if (!locationId) return res.status(400).json({ error: 'Missing locationId/altId' });
    if (amountJMD < 80) return res.status(400).json({ error: 'Amount too low, minimum J$80' });
    var cfg = await getMerchantConfig(locationId);
    if (!cfg || !cfg.handypay_api_key) {
      return res.status(400).json({ error: 'HandyPay not configured for location: ' + locationId });
    }
    var session = await createHandyPaySession(
      cfg.handypay_api_key,
      amountJMD,
      description,
      { contact_id: contactId, location_id: locationId, entity_id: entityId, payment_type: 'ghl_native' },
      true
    );
    var sessionId = session.id || session.sessionId || session.session_id;
    var checkoutUrl = session.url || session.checkout_url || session.checkoutUrl;
    // Store in DB so GET /api/pay can look up checkout_url
    await pool.query(
      `INSERT INTO payment_logs (session_id, location_id, contact_id, amount, currency, status, payment_type, checkout_url)
       VALUES ($1, $2, $3, $4, 'JMD', 'pending', 'ghl_native', $5)
       ON CONFLICT (session_id) DO UPDATE SET checkout_url=$5, updated_at=NOW()`,
      [sessionId, locationId, contactId, Math.round(amountJMD), checkoutUrl]
    );
    console.log('[/api/pay POST] stored session:', sessionId, checkoutUrl);
    return res.json({ paymentIntentId: sessionId, checkoutUrl: checkoutUrl });
  } catch (err) {
    console.error('[/api/pay POST] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.all(['/api/query', '/api/query/:paymentIntentId'], async (req, res) => {
  // Support both query param AND path param (GHL uses path param format)
  // Support path param, query param, AND body param (GHL sends POST with body)
  if (req.params && req.params.paymentIntentId && !req.query.paymentIntentId) {
    req.query.paymentIntentId = req.params.paymentIntentId;
  }
  if (req.body && (req.body.paymentIntentId || req.body.chargeId || req.body.transactionId) && !req.query.paymentIntentId) {
    req.query.paymentIntentId = req.body.paymentIntentId || req.body.chargeId || req.body.transactionId;
  }
  try {
    var paymentIntentId = req.query.paymentIntentId || req.query.sessionId || '';
    console.log('[/api/query GET] paymentIntentId:', paymentIntentId);
    if (!paymentIntentId) return res.json({ status: 'pending' });
    var log = await getPaymentLogBySession(paymentIntentId);
    if (!log) {
      var rows2 = (await pool.query('SELECT * FROM payment_logs WHERE ghl_transaction_id=$1 ORDER BY created_at DESC LIMIT 1', [paymentIntentId]).catch(function(){return {rows:[]};} )).rows;
      if (rows2 && rows2.length) log = rows2[0];
    }
    var status = (log && log.status) || 'pending';
    // If DB shows pending AND it's a ghl_native session, verify directly with HandyPay API
    if ((status === 'pending' || status === 'paid') && log && log.payment_type === 'ghl_native') {
      try {
        var cfg = await getMerchantConfig(log.location_id);
        if (cfg && cfg.handypay_api_key) {
          var hpSid = (log && log.session_id) ? log.session_id : paymentIntentId;
    var hpResp = await fetch(HP_BASE + '/payment-sessions/' + hpSid, {
            headers: { 'Authorization': 'Bearer ' + cfg.handypay_api_key }
          });
          if (hpResp.ok) {
            var hpData = await hpResp.json();
            var hpSession = hpData.data || hpData;
            var hpPayStatus = hpSession.payment_status || hpSession.status || '';
            console.log('[/api/query] HandyPay status for', paymentIntentId, ':', hpPayStatus);
            if (hpPayStatus === 'paid' || hpSession.status === 'complete') {
              // Update DB and return succeeded
              await updatePaymentLogStatus((log && log.session_id) ? log.session_id : paymentIntentId, 'paid');
              return res.json({ status: 'succeeded', paymentIntentId: paymentIntentId });
              // RECORD-PAYMENT: Call GHL API to mark invoice as paid
              try {
                if (log && log.appointment_id && log.location_id) {
                  var rpCfg = cfg || (await getMerchantConfig(log.location_id).catch(function(){return null;}));
                  if (rpCfg && rpCfg.ghl_access_token) {
                    var rpTok = rpCfg.ghl_access_token;
                    try { var rpRef = await refreshCrmToken(log.location_id); if (rpRef && rpRef.access_token) rpTok = rpRef.access_token; } catch(e3){}
                    fetch(GHL_API + '/invoices/' + log.appointment_id + '/record-payment', {
                      method: 'POST',
                      headers: { 'Authorization': 'Bearer ' + rpTok, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
                      body: JSON.stringify({ altId: log.location_id, altType: 'location', amount: log.amount, currency: 'JMD', paymentMethod: 'custom', source: 'custom', mode: 'live', notes: 'HandyPay:' + ((log && log.session_id) || paymentIntentId) })
                    }).then(function(rp){ console.log('[query/record-payment]', log.appointment_id, rp.status); }).catch(function(e4){ console.error('[query/record-payment]', e4.message); });
                  }
                }
              } catch(rpErr) { console.error('[query/record-payment]:', rpErr.message); }            }
          }
        }
      } catch (e) { console.error('[/api/query] HP check error:', e.message); }
    }
    var ghlStatus = (status === 'paid' || status === 'completed') ? 'succeeded' : status === 'failed' ? 'failed' : status === 'expired' ? 'cancelled' : 'pending';
    console.log('[/api/query GET] final status:', ghlStatus);
    return res.json({ status: ghlStatus, paymentIntentId: paymentIntentId });
  } catch (err) {
    console.error('[/api/query GET] ERROR:', err.message);
    return res.json({ status: 'pending' });
  }
});

// ============================================================
// DB INIT + MIGRATION
// ============================================================
app.get('/api/init-db', async (req, res) => {
  if (req.query.secret !== process.env.INIT_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS merchant_configs (
        location_id VARCHAR(255) PRIMARY KEY,
        handypay_api_key TEXT,
        crm_access_token TEXT,
        crm_refresh_token TEXT,
        mode VARCHAR(20) DEFAULT 'test',
        deposit_amount INTEGER DEFAULT 5000,
        sms_template TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS payment_logs (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        location_id VARCHAR(255),
        session_id VARCHAR(255),
        contact_id VARCHAR(255),
        appointment_id VARCHAR(255),
        amount INTEGER,
        currency VARCHAR(10) DEFAULT 'JMD',
        status VARCHAR(50) DEFAULT 'pending',
        access_token TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE merchant_configs ADD COLUMN IF NOT EXISTS sms_template TEXT DEFAULT '';
      ALTER TABLE merchant_configs ADD COLUMN IF NOT EXISTS deposit_amount INTEGER DEFAULT 5000;
      ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS appointment_id VARCHAR(255);
      ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS access_token TEXT;
      ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
      ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS session_id VARCHAR(255);
      CREATE UNIQUE INDEX IF NOT EXISTS payment_logs_session_id_idx ON payment_logs(session_id);
      ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS amount INTEGER DEFAULT 0;
      ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'JMD';
      ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS contact_id VARCHAR(255);
      ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS location_id VARCHAR(255);
      ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending';
    CREATE TABLE IF NOT EXISTS short_links (
      id           SERIAL PRIMARY KEY,
      code         TEXT UNIQUE NOT NULL,
      full_url     TEXT NOT NULL,
      session_id   TEXT,
      location_id  TEXT,
      contact_id   TEXT,
      payment_type TEXT DEFAULT 'deposit',
      clicks       INTEGER DEFAULT 0,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sl_code    ON short_links(code);
    CREATE INDEX IF NOT EXISTS idx_sl_contact ON short_links(contact_id, location_id);
    CREATE INDEX IF NOT EXISTS idx_sl_session ON short_links(session_id);
    ALTER TABLE merchant_configs ADD COLUMN IF NOT EXISTS handypay_webhook_id VARCHAR(100);
    ALTER TABLE merchant_configs ADD COLUMN IF NOT EXISTS handypay_webhook_secret VARCHAR(100);
        ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS checkout_url TEXT;
    ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS entity_id VARCHAR(255);
    ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS payment_type TEXT DEFAULT 'deposit';
    ALTER TABLE merchant_configs ADD COLUMN IF NOT EXISTS deposit_percentage INTEGER DEFAULT 30;
    ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS ghl_transaction_id TEXT;
    ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS appointment_id_v2 TEXT;
    CREATE TABLE IF NOT EXISTS debug_messages (id SERIAL PRIMARY KEY, location_id TEXT, message TEXT, origin TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS debug_messages (
      id SERIAL PRIMARY KEY, location_id TEXT, message TEXT, origin TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    `);
    res.json({ ok: true, message: 'DB initialized/migrated.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// GHL NATIVE PAYMENT - INITIATION
// GHL calls this when customer pays invoice/order via HandyPay
// ============================================================
app.post('/api/pay', async (req, res) => {
  try {
    var body = req.body;
    var locationId = (body.meta && body.meta.locationId) || body.locationId || body.altId || '';
    var amountCents = parseInt(body.amount) || 0;
    var currency = (body.currency || 'JMD').toUpperCase();
    var description = body.description || 'Payment';
    var contact = body.contact || {};
    var contactId = contact.id || '';
    if (!locationId) return res.status(400).json({ error: 'Missing locationId in request' });
    var cfg = await getMerchantConfig(locationId);
    if (!cfg || !cfg.handypay_api_key) {
      return res.status(400).json({ error: 'HandyPay not configured. Complete setup in Settings.' });
    }
    var amountJMD = amountCents / 100;
    var meta = { locationId: locationId, contactId: contactId, source: 'ghl_native', description: description };
    var session = await createHandyPaySession(cfg.handypay_api_key, amountJMD, description, meta, true);
    var sessionId = session.id || session.sessionId || session.paymentSessionId;
    var checkoutUrl = session.url || session.checkoutUrl || session.payment_url || session.paymentUrl;
    if (!sessionId || !checkoutUrl) {
      return res.status(500).json({ error: 'HandyPay did not return a valid session', raw: session });
    }
    await pool.query(
      'INSERT INTO payment_logs (session_id,contact_id,location_id,amount,currency,status,payment_type,checkout_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (session_id) DO NOTHING',
      [sessionId, contactId, locationId, amountJMD, currency, 'pending', 'ghl_native', checkoutUrl]
    ).catch(function(e) { console.error('[pay-log]', e.message); });
    console.log('[/api/pay] locationId=%s amount=%s sessionId=%s', locationId, amountJMD, sessionId);
    return res.json({ paymentIntentId: sessionId, checkoutUrl: checkoutUrl });
  } catch (e) {
    console.error('[/api/pay] ERROR', e.message);
    return res.status(500).json({ error: e.message });
  }
});
// ============================================================
// GHL NATIVE PAYMENT - STATUS QUERY
// GHL polls this to check if HandyPay payment succeeded
// ============================================================
app.get('/api/query', async (req, res) => {
  try {
    var paymentIntentId = req.query.paymentIntentId || req.query.sessionId || req.query.id;
    if (!paymentIntentId) return res.status(400).json({ error: 'Missing paymentIntentId' });
    var log = await getPaymentLogBySession(paymentIntentId);
    if (!log) return res.status(404).json({ error: 'Payment not found', paymentIntentId: paymentIntentId });
    var statusMap = { paid: 'succeeded', pending: 'pending', superseded: 'cancelled', expired: 'cancelled', failed: 'failed' };
    var ghlStatus = statusMap[log.status] || 'pending';
    return res.json({ paymentIntentId: paymentIntentId, status: ghlStatus, amount: Math.round((parseFloat(log.amount) || 0) * 100), currency: log.currency || 'JMD' });
  } catch (e) {
    console.error('[/api/query] ERROR', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ============================================================
// ============================================================
// ============================================================
// GHL CUSTOM PAYMENT PROVIDER - CORRECT PROTOCOL (v4)
// All messages must be JSON.stringify() strings, NOT objects
// custom_provider_ready -> payment_initiate_props -> custom_element_success_response
// ============================================================
app.get('/api/pay', async (req, res) => {
  try {
    var q = req.query;
    var locationId = q.locationId || q.location_id || q.altId || '';
    console.log('[/api/pay GET] locationId:', locationId);
    if (!locationId) return res.status(400).send('<html><body><h2>HandyPay Error</h2><p>Missing locationId.</p></body></html>');
    var cfg = await getMerchantConfig(locationId);
    if (!cfg || !cfg.handypay_api_key) return res.status(400).send('<html><body><h2>HandyPay not configured</h2></body></html>');
    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandyPay</title>'
      + '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f4f6fb;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}.card{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.09);padding:28px;max-width:380px;width:100%;text-align:center}.logo{font-size:36px;margin-bottom:10px}h2{color:#D10039;font-size:18px;font-weight:800;margin-bottom:4px}.amt{font-size:30px;font-weight:900;color:#1a1a1a;margin:10px 0;display:none}.lbl{font-size:13px;color:#888;margin-bottom:14px}.btn{width:100%;background:#D10039;color:#fff;border:none;border-radius:9px;padding:13px;font-size:15px;font-weight:700;cursor:pointer;display:none}.btn:disabled{background:#ccc}.st{font-size:13px;color:#555;margin-top:6px}</style>'
      + '</head><body><div class="card"><div class="logo">&#x1F4B3;</div><h2>HandyPay</h2><div class="amt" id="a"></div><div class="lbl" id="l">Loading payment details...</div><button class="btn" id="b" onclick="openHP()">Open HandyPay Checkout</button><div class="st" id="s"></div></div>'
      + '<script>var L="' + locationId + '",done=false,SID="",poll=null,AMT=0,DESC="Invoice Payment",INV="";'
      + 'function ss(t){document.getElementById("s").textContent=t;}'
      + 'function jmd(raw,cur){var n=parseFloat(raw)||0;if(!n)return 0;cur=(cur||("")).toUpperCase();if(cur==="USD")return Math.round((n>=100?n/100:n)*155);return n;}'
      + 'function openHP(){if(done)return;document.getElementById("b").disabled=true;ss("Opening HandyPay...");'
      + 'fetch("/api/create-native-session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({locationId:L,amountJMD:AMT,description:DESC,entityId:INV,ghlTransactionId:window._GHL_TXN||""})})'
      + '.then(function(r){return r.json();}).then(function(d){if(!d.checkoutUrl){ss("Error: "+(d.error||"?"));document.getElementById("b").disabled=false;return;}'
      + 'SID=d.sessionId||d.paymentIntentId||"";var w=window.open(d.checkoutUrl,"_blank");if(!w){ss("Popup blocked");document.getElementById("b").disabled=false;done=false;return;}'
      + 'done=true;ss("\u23F3 HandyPay open in new tab. Return here after paying.");'
      + 'poll=setInterval(function(){if(!SID)return;fetch("/api/query?paymentIntentId="+SID).then(function(r){return r.json();}).then(function(qd){'
      + 'if(qd.status==="succeeded"){clearInterval(poll);ss("\u2705 Payment confirmed!");'
      + 'window.parent.postMessage(JSON.stringify({type:"custom_element_success_response",chargeId:(window._GHL_TXN||SID)}),"*");'
      + 'setTimeout(function(){window.parent.postMessage(JSON.stringify({type:"custom_element_close_response"}),"*");},1500);}}).catch(function(){});},3000);'
      + '}).catch(function(e){ss("Error: "+e.message);document.getElementById("b").disabled=false;done=false;});}'
      + 'window.addEventListener("message",function(e){var data;try{data=JSON.parse(e.data);}catch(x){return;}'
      + 'if(data.type==="payment_initiate_props"){AMT=jmd(data.amount,data.currency);DESC=data.description||data.name||"Invoice Payment";INV=data.entityId||data.invoiceId||data.orderId||"";window._GHL_TXN=data.transactionId||data.invoiceId||"";'
      + 'document.getElementById("a").textContent="J$"+AMT.toLocaleString();document.getElementById("a").style.display="block";document.getElementById("l").textContent="Invoice Payment";document.getElementById("b").style.display="block";setTimeout(openHP,500);}});'
      + 'try{window.parent.postMessage(JSON.stringify({type:"custom_provider_ready",loaded:true}),"*");}catch(x){ss("Blocked: "+x.message);}'
      + '<\/script></body></html>';
    res.setHeader('Content-Type','text/html');
    return res.send(html);
  } catch(e) {
    console.error('[/api/pay GET] CRASH:', e.message);
    return res.status(500).send('<h2>HandyPay Error: ' + e.message + '</h2>');
  }
});

// =================================================================
// QUERY — POST (GHL backend server calls POST /api/query to verify payment)
// GHL sends: { chargeId, transactionId, apiKey, type: "verify" }
// We must return: { status: "succeeded" } for paid sessions
// =================================================================
app.post('/api/query', async function(req, res) {
  var chargeId = req.body.chargeId || req.body.paymentIntentId || req.body.sessionId;
  var transactionId = req.body.transactionId;
  var apiKey = req.body.apiKey;
  await pool.query('INSERT INTO debug_messages (location_id, message, origin) VALUES ($1, $2, $3)',
    ['post-query', JSON.stringify({ chargeId: chargeId, txn: transactionId, type: req.body.type }), 'post-query-handler']
  ).catch(function(){});
  if (!chargeId && !transactionId) return res.json({ status: 'pending' });
  try {
    var log = null;
    if (chargeId) {
      var r1 = await pool.query('SELECT * FROM payment_logs WHERE session_id = $1', [chargeId]);
      log = r1.rows[0] || null;
    }
    if (!log && transactionId) {
      var r2 = await pool.query('SELECT * FROM payment_logs WHERE ghl_transaction_id = $1', [transactionId]);
      log = r2.rows[0] || null;
    }
    // DB says paid — fast path
    if (log && (log.status === 'paid' || log.status === 'completed')) {
      return res.json({ status: 'succeeded', paymentIntentId: chargeId || transactionId });
    }
    // Verify directly with HandyPay using /payment-sessions/ endpoint (same as GET handler)
    var keyToUse = apiKey || (log && log.access_token) || process.env.HANDYPAY_API_KEY;
    var sessionIdToCheck = chargeId || (log && log.session_id);
    if (keyToUse && sessionIdToCheck) {
      try {
        var hpRes = await fetch(HP_BASE + '/payment-sessions/' + sessionIdToCheck, {
          headers: { 'Authorization': 'Bearer ' + keyToUse }
        });
        var hpJson = await hpRes.json();
        var hpData = hpJson && hpJson.data ? hpJson.data : hpJson;
        var hpStatus = (hpData && hpData.status) || '';
        var hpPaymentStatus = (hpData && hpData.payment_status) || '';
        await pool.query('INSERT INTO debug_messages (location_id, message, origin) VALUES ($1, $2, $3)',
          ['post-query', JSON.stringify({ hpStatus: hpStatus, hpPayStatus: hpPaymentStatus }), 'post-query-hp']
        ).catch(function(){});
        if (hpStatus === 'complete' || hpPaymentStatus === 'paid' || hpStatus === 'paid') {
          if (log) {
            await pool.query('UPDATE payment_logs SET status=$1, updated_at=NOW() WHERE session_id=$2', ['paid', log.session_id]).catch(function(){});
          }
          return res.json({ status: 'succeeded', paymentIntentId: sessionIdToCheck });
        }
      } catch(hpErr) {
        await pool.query('INSERT INTO debug_messages (location_id, message, origin) VALUES ($1, $2, $3)',
          ['post-query', hpErr.message || 'hp_err', 'post-query-hp-err']).catch(function(){});
      }
    }
    return res.json({ status: 'pending', paymentIntentId: chargeId || transactionId });
  } catch(err) {
    return res.json({ status: 'pending', error: err.message });
  }
});

app.post('/api/create-native-session', async (req, res) => {
  try {
    var locationId=req.body.locationId, amountJMD=parseFloat(req.body.amountJMD)||0;
    var description=req.body.description||'Invoice Payment', contactId=req.body.contactId||'', entityId=req.body.entityId||'', ghlTransactionId=req.body.ghlTransactionId||'';
    console.log('[create-native-session]',locationId,amountJMD);
    if(!locationId||amountJMD<80) return res.status(400).json({error:'Need locationId+amountJMD>=80. Got:'+amountJMD});
    var cfg=await getMerchantConfig(locationId);
    if(!cfg||!cfg.handypay_api_key) return res.status(400).json({error:'Not configured: '+locationId});
    var session=await createHandyPaySession(cfg.handypay_api_key,amountJMD,description,
      {contact_id:contactId,location_id:locationId,entity_id:entityId,payment_type:'ghl_native'},true);
    var sessionId=session.id||session.sessionId||session.session_id;
    var checkoutUrl=session.url||session.checkout_url||session.checkoutUrl;
    await pool.query(
      `INSERT INTO payment_logs (session_id,location_id,contact_id,amount,currency,status,payment_type,checkout_url,appointment_id,ghl_transaction_id)
       VALUES ($1,$2,$3,$4,'JMD','pending','ghl_native',$5,$6,$7)
       ON CONFLICT (session_id) DO UPDATE SET checkout_url=$5,appointment_id=$6,ghl_transaction_id=$7,updated_at=NOW()`,
      [sessionId,locationId,contactId,Math.round(amountJMD),checkoutUrl,entityId||null,ghlTransactionId||null]
    );
    console.log('[create-native-session] ok:',sessionId);
    return res.json({sessionId,checkoutUrl,paymentIntentId:ghlTransactionId||sessionId});
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
