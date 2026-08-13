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

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ============================================================
// HEALTH
// ============================================================
app.get('/', (req, res) => res.json({ status: 'ok', service: 'HandyPay Deposits v2.0' }));
// ============================================================
// SUCCESS / CANCEL PAGES
// ============================================================
app.get('/success', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Confirmed</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0fdf4;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;width:100%;padding:40px;text-align:center}.icon{font-size:64px;margin-bottom:16px}h1{font-size:22px;font-weight:800;color:#15803d;margin-bottom:10px}p{font-size:15px;color:#555;line-height:1.6}.sub{font-size:13px;color:#888;margin-top:20px}</style></head><body><div class="card"><div class="icon">\u2705</div><h1>Payment Confirmed!</h1><p>Thank you for your payment. Your appointment is confirmed and a reminder will be sent before your visit.</p><p class="sub">You can close this window.</p></div></body></html>');
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
  if (!cfg || !cfg.crm_refresh_token) throw new Error('No refresh token');
  const r = await fetch(GHL_API + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GHL_CLIENT_ID, client_secret: GHL_CLIENT_SECRET,
      grant_type: 'refresh_token', refresh_token: cfg.crm_refresh_token
    })
  });
  if (!r.ok) throw new Error('Token refresh ' + r.status);
  const data = await r.json();
  await pool.query(
    'UPDATE merchant_configs SET crm_access_token=$1, crm_refresh_token=$2, updated_at=NOW() WHERE location_id=$3',
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
  var body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
  var amount = body.amount, currency = body.currency, contactId = body.contactId, locationId = body.locationId;
  try {
    var config = await getMerchantConfig(locationId);
    if (!config || !config.handypay_api_key) return res.status(400).json({ error: 'HandyPay not configured' });
    var session = await createHandyPaySession(config.handypay_api_key, {
      amount: Math.round(amount), currency: currency || 'JMD', contact: {},
      metadata: { contact_id: contactId, location_id: locationId },
      successUrl: APP_URL + '/api/payment-success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: APP_URL + '/api/payment-cancel'
    });
    res.json({ paymentUrl: session.url || session.payment_url, sessionId: session.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/query', async (req, res) => {
  var body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
  var sessionId = body.sessionId;
  try {
    var log = await getPaymentLogBySession(sessionId);
    res.json({ status: (log && log.status) || 'pending', sessionId: sessionId });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
      'INSERT INTO payment_logs (session_id,contact_id,location_id,amount,currency,status,payment_type) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (session_id) DO NOTHING',
      [sessionId, contactId, locationId, amountJMD, currency, 'pending', 'ghl_native']
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
// GHL NATIVE PAYMENT - GET REDIRECT (browser redirect from GHL)
// GHL redirects customer browser here via GET with payment params
// We create HandyPay session then redirect customer to checkout
// ============================================================
app.get('/api/pay', async (req, res) => {
  try {
    var q = req.query;
    console.log('[/api/pay GET] params:', JSON.stringify(q));
    var locationId = q.locationId || q.location_id || q.altId || '';
    var amountCents = parseInt(q.amount) || 0;
    var currency = (q.currency || 'JMD').toUpperCase();
    var description = q.description || q.entityType || 'Invoice Payment';
    var contactId = q.contactId || q.contact_id || '';
    var entityId = q.entityId || q.invoiceId || '';
    if (!locationId) {
      return res.status(400).send('<html><body style="font-family:sans-serif;padding:40px"><h2>HandyPay Error</h2><p>Missing locationId. Params received: ' + JSON.stringify(q) + '</p></body></html>');
    }
    var cfg = await getMerchantConfig(locationId);
    if (!cfg || !cfg.handypay_api_key) {
      return res.status(400).send('<html><body style="font-family:sans-serif;padding:40px"><h2>HandyPay not configured</h2><p>Please complete setup in HandyPay Settings for locationId: ' + locationId + '</p></body></html>');
    }
    
  } catch (e) {
    console.error('[/api/pay GET] ERROR', e.message);
    return res.status(500).send('<h2>HandyPay Error: ' + e.message + '</h2>');
  }
});

// ============================================================
// RE-REGISTER PAYMENT PROVIDER (admin tool)
// POST /api/re-register?secret=xxx&locationId=xxx
// ============================================================
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
