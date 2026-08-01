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
    const cr = await fetch(GHL_API + '/conversations/', {
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
    body: JSON.stringify({ type: 'SMS', message: message, conversationId: conversationId })
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
// HANDYPAY HELPERS
// ============================================================
async function createHandyPaySession(apiKey, opts) {
  var amount = opts.amount, currency = opts.currency || 'JMD',
      contact = opts.contact || {}, metadata = opts.metadata || {},
      successUrl = opts.successUrl, cancelUrl = opts.cancelUrl;
  // HandyPay (Stripe Connect) requires line_items format
  var payload = {
    line_items: [{
      price_data: {
        currency: currency.toLowerCase(),
        unit_amount: amount,
        product_data: { name: 'Appointment Deposit' }
      },
      quantity: 1
    }],
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: metadata
  };
  if (contact.email) payload.customer_email = contact.email;
  if (contact.name) payload.customer_name = contact.name;
  console.log('[HandyPay] Creating session, amount:', amount, currency);
  var r = await fetch(HP_BASE + '/payment-sessions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  var text = await r.text();
  console.log('[HandyPay] Session response:', r.status, text.substring(0, 300));
  if (!r.ok) throw new Error('HandyPay session ' + r.status + ': ' + text);
  return JSON.parse(text);
}

// ============================================================
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
        paymentsUrl: APP_URL + '/api/pay',
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
  var raw = Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
  var body = Buffer.isBuffer(req.body) ? JSON.parse(raw) : req.body;

  // CRM workflow webhooks wrap custom data under "customData" key
  var cd = body.customData || {};
  console.log('[CRM webhook] FULL BODY:', JSON.stringify(body).substring(0, 600));

  var type = body.type || cd.type;
  var locationId = body.locationId || cd.locationId || body.location_id || cd.location_id;
  var contactId = body.contactId || cd.contactId || (body.contact && body.contact.id);
  var appointmentId = body.id || cd.appointmentId || body.appointmentId;
  var startTime = body.startTime || cd.startTime;
  var title = body.title || cd.title;

  console.log('[CRM webhook] type:', type, '| loc:', locationId, '| contact:', contactId);

  var isAppt = !type || ['AppointmentCreate', 'appointmentCreate', 'appointment.create'].indexOf(type) !== -1;
  if (!isAppt) return res.json({ ok: true, skipped: type });

  try {
    var config = await getMerchantConfig(locationId);
    if (!config) return res.json({ ok: true, note: 'no_config' });
    if (!config.handypay_api_key || config.handypay_api_key === 'hp_pending_setup')
      return res.json({ ok: true, note: 'api_key_not_set' });
    if (!config.deposit_amount || config.deposit_amount < 100)
      return res.json({ ok: true, note: 'deposit_amount_not_set' });
    if (!contactId) return res.json({ ok: true, note: 'no_contact_id' });

    var accessToken = config.crm_access_token;
    var contact = body.contact || {};

    // Fetch full contact details
    if (accessToken && (!contact.phone || !contact.firstName)) {
      try {
        var c = await getContact(accessToken, contactId);
        contact = Object.assign({}, c, contact);
      } catch (e) {
        try {
          accessToken = await refreshCrmToken(locationId);
          var c2 = await getContact(accessToken, contactId);
          contact = Object.assign({}, c2, contact);
        } catch (e2) { console.error('[webhook] contact fetch failed:', e2.message); }
      }
    }

    var phone = contact.phone || contact.phoneRaw;
    if (!phone) {
      console.error('[webhook] Contact', contactId, 'has no phone number -- skipping SMS');
      return res.json({ ok: true, note: 'no_phone' });
    }

    var firstName = contact.firstName || 'there';
    var depositAmount = config.deposit_amount;

    var apptDate = 'your upcoming appointment';
    if (startTime) {
      try {
        apptDate = new Date(startTime).toLocaleDateString('en-JM', {
          weekday: 'long', month: 'long', day: 'numeric',
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Jamaica'
        });
      } catch (e) { apptDate = startTime; }
    }

    console.log('[webhook] Creating HandyPay session -- JMD', depositAmount);
    var session = await createHandyPaySession(config.handypay_api_key, {
      amount: depositAmount,
      currency: 'JMD',
      contact: { name: firstName, email: contact.email, phone: phone },
      metadata: {
        contact_id: contactId, location_id: locationId,
        appointment_id: appointmentId || '', title: title || ''
      },
      successUrl: APP_URL + '/api/payment-success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: APP_URL + '/api/payment-cancel'
    });

    var paymentUrl = session.url || session.payment_url || session.checkout_url || session.checkoutUrl;
    var sessionId = session.id || session.session_id || session.sessionId;

    if (!paymentUrl) {
      console.error('[webhook] No payment URL -- HandyPay response:', JSON.stringify(session));
      return res.json({ ok: false, error: 'No payment URL from HandyPay', raw: session });
    }

    // Log to DB
    await pool.query(
      'INSERT INTO payment_logs (location_id,session_id,contact_id,appointment_id,amount,currency,status,access_token,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT (session_id) DO NOTHING',
      [locationId, sessionId, contactId, appointmentId || '', depositAmount, 'JMD', 'pending', accessToken]
    );

    // Build SMS message
    var tmpl = config.sms_template;
    var sms;
    if (tmpl) {
      sms = tmpl
        .replace('{name}', firstName)
        .replace('{amount}', depositAmount.toLocaleString())
        .replace('{date}', apptDate)
        .replace('{link}', paymentUrl);
    } else {
      sms = 'Hi ' + firstName + '! Your appointment for ' + apptDate + ' has been requested.\n\nPay your deposit of JMD $' + depositAmount.toLocaleString() + ' to confirm your spot:\n\n' + paymentUrl + '\n\nLink expires in 24 hours.';
    }

    await sendSms(accessToken, locationId, contactId, sms);
    console.log('[webhook] Deposit SMS sent | session:', sessionId, '| contact:', contactId);

    res.json({ ok: true, sessionId: sessionId, smsStatus: 'sent' });
  } catch (err) {
    console.error('[CRM webhook ERROR]', err.message, err.stack);
    res.json({ ok: false, error: err.message });
  }
});

// ============================================================
// HANDYPAY PAYMENT WEBHOOK  <-- CONFIRM DEPOSIT
// ============================================================
app.post('/api/webhooks/handypay', async (req, res) => {
  var raw = Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
  var sig = req.headers['handypay-signature'] || req.headers['stripe-signature'] || req.headers['x-handypay-signature'] || '';

  if (process.env.HANDYPAY_WEBHOOK_SECRET && sig) {
    var expected = crypto.createHmac('sha256', process.env.HANDYPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    if (sig.indexOf(expected) === -1) {
      console.error('[hp webhook] Bad signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  var body = Buffer.isBuffer(req.body) ? JSON.parse(raw) : req.body;
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
    var log = await getPaymentLogBySession(sessionId);
    if (!log) { console.error('[hp webhook] No log for session:', sessionId); return; }

    var contactId = log.contact_id;
    var accessToken = log.access_token;
    var amount = log.amount;
    var locationId = log.location_id;
    var appointmentId = log.appointment_id;

    await addContactTag(accessToken, contactId, ['deposit-paid']);
    await addContactNote(accessToken, contactId,
      'Deposit Received\nAmount: JMD $' + ((amount || amountReceived || 0)).toLocaleString() + '\nSession: ' + sessionId + '\nAppointment: ' + (appointmentId || 'N/A') + '\nPowered by HandyPay'
    );
    await updatePaymentLogStatus(sessionId, 'paid');
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
    `);
    res.json({ ok: true, message: 'DB initialized/migrated.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = app;
