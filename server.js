const express = require('express');
// server.js — HandyPay Deposits App (GHL-native architecture)
// Removed in GHL-native refactor (GHL workflows handle all CRM actions):
//   - getContact() — not needed; app only writes fields, not reads
//   - refreshCrmToken() — replaced by lib/token.js getFreshToken()
//   - sendSms() — GHL Workflow 1 sends all deposit SMS
//   - addContactNote() — GHL Workflow 2 adds all notes
//   - sendGHLPaymentCapturedWebhook() — no-op, removed
//   - /api/webhooks/followup — GHL Workflow 3 handles deposit reminders natively
//
// App now does ONLY: create HP session + write 2 contact fields + GHL invoice payments

const crypto = require('crypto');
const { Pool } = require('pg');
const app = express();

const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_CLIENT_ID = process.env.GHL_CLIENT_ID;
const GHL_CLIENT_SECRET = process.env.GHL_CLIENT_SECRET;
const HP_BASE = 'https://api.handypay.me/api/v1';
const APP_URL = process.env.APP_URL || 'https://handypay-deposits-app.vercel.app';
const LOGO_URL = 'https://storage.googleapis.com/crm-conversations-ai-production/ask-ai-images/1785549533996/aaf88bbe-7f89-44b6-ba1b-12a6417755f6.png';
const INIT_SECRET = process.env.INIT_SECRET || 'handypay-init-2026-lnet';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 30000
});

app.use((req, res, next) => {
  if (req.path === '/api/webhooks/handypay') return next();
  express.json({ limit: '2mb' })(req, res, next);
});
app.use(express.urlencoded({ extended: true }));

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
async function fireRecordPayment(invoiceId, locationId, amount, note, token) {
  const r = await fetch(GHL_API + '/invoices/' + invoiceId + '/record-payment', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
    body: JSON.stringify({ locationId, amount, note: note || 'HandyPay', paymentMode: 'cash', isNotified: false })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('record-payment ' + r.status + ': ' + JSON.stringify(d).slice(0, 80));
  return d;
}

async function addTag(accessToken, contactId, tags) {
  const r = await fetch(GHL_API + '/contacts/' + contactId + '/tags', { method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-07-28' }, body: JSON.stringify({ tags }) });
  if (!r.ok) console.error('[tag] failed:', r.status);
  return r.json().catch(function() {});
}

// updateContactField: writes custom fields to contact
// GHL workflows read these fields and send SMS, add tags, notes, upsells
async function updateContactField(accessToken, locationId, contactId, fieldMap) {
  if (!accessToken || !contactId) return false;
  const customFields = Object.entries(fieldMap).map(([key, field_value]) => ({ key, field_value: String(field_value == null ? '' : field_value) }));
  try {
    const r = await fetch(GHL_API + '/contacts/' + contactId, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-07-28' }, body: JSON.stringify({ locationId, customFields }) });
    if (!r.ok) { const t = await r.text().catch(() => ''); console.error('[updateContactField]', r.status, t.slice(0,100)); return false; }
    return true;
  } catch(e) { console.error('[updateContactField] error:', e.message); return false; }
}

function generateCode() { var c = 'abcdefghjkmnpqrstuvwxyz23456789'; var code = ''; for(var i=0;i<6;i++) code += c[Math.floor(Math.random()*c.length)]; return code; }
async function createShortLink(fullUrl, sessionId, locationId, contactId, paymentType) {
  for(var attempt=0; attempt<10; attempt++) {
    var sc = generateCode();
    try { await pool.query('INSERT INTO short_links (code,full_url,session_id,location_id,contact_id,payment_type) VALUES ($1,$2,$3,$4,$5,$6)', [sc, fullUrl, sessionId, locationId, contactId, paymentType]); return APP_URL + '/p/' + sc; }
    catch(e) { if(e.code!=='23505') throw e; }
  }
  return fullUrl;
}

async function createHandyPaySession(apiKey, amountJMD, label, meta, passFeesToCustomer) {
  if(passFeesToCustomer===undefined) passFeesToCustomer=true;
  var r = await fetch(HP_BASE + '/payment-sessions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: amountJMD, currency: 'jmd', label, pass_fees_to_customer: passFeesToCustomer, success_url: APP_URL + '/success', cancel_url: APP_URL + '/cancel', metadata: meta || {} }) });
  var d = await r.json();
  if(!r.ok) throw new Error('HP session ' + r.status + ': ' + JSON.stringify(d).slice(0,80));
  var data = d.data || d;
  var id = data.id || data.session_id || data.sessionId || '';
  var url = data.url || data.checkout_url || data.checkoutUrl || '';
  if(!id) throw new Error('HP session: no id: ' + JSON.stringify(data).slice(0,80));
  return { id, url };
}

async function getFreshToken(locationId) {
  const { rows } = await pool.query('SELECT crm_access_token, crm_refresh_token FROM merchant_configs WHERE location_id=$1', [locationId]);
  const cfg = rows[0];
  if (!cfg || !cfg.crm_access_token) throw new Error('no_config');
  if (!cfg.crm_refresh_token) { console.log('[getFreshToken] PIT mode for', locationId); return cfg.crm_access_token; }
  const r = await fetch(GHL_API + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: GHL_CLIENT_ID, client_secret: GHL_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: cfg.crm_refresh_token }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('token_refresh ' + r.status + ':' + (d.message||''));
  await pool.query('UPDATE merchant_configs SET crm_access_token=$1, crm_refresh_token=$2, updated_at=NOW() WHERE location_id=$3', [d.access_token, d.refresh_token, locationId]);
  return d.access_token;
}

async function registerHandyPayWebhook(apiKey, locationId) {
  try {
    const existing = await getMerchantConfig(locationId);
    if (existing && existing.handypay_webhook_id) { await fetch(HP_BASE + '/webhook-endpoints/' + existing.handypay_webhook_id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + apiKey } }).catch(() => {}); }
    var r = await fetch(HP_BASE + '/webhook-endpoints', { method: 'POST', headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: APP_URL + '/api/webhooks/handypay', events: ['checkout.session.completed', 'checkout.session.expired'], isActive: true }) });
    var d = await r.json();
    var wid = (d.data && d.data.id) || d.id || '';
    var wsec = (d.data && d.data.secret) || d.secret || '';
    if (wid) { await pool.query('UPDATE merchant_configs SET handypay_webhook_id=$1, handypay_webhook_secret=$2 WHERE location_id=$3', [wid, wsec, locationId]); }
    return { ok: true, webhookId: wid };
  } catch(e) { console.error('[registerHandyPayWebhook]', e.message); return { ok: false, error: e.message }; }
}

async function activatePaymentModes(locationId, accessToken, apiKey, mode) {
  try {
    const provResp = await fetch(GHL_API + '/payments/custom-provider/provider?locationId=' + locationId, { method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-07-28' }, body: JSON.stringify({ locationId, name: 'HandyPay', description: 'Pay securely via HandyPay', paymentsUrl: APP_URL + '/api/pay', queryUrl: APP_URL + '/api/query', imageUrl: LOGO_URL }) });
    const provData = await provResp.json().catch(() => ({}));
    console.log('[activatePaymentModes] provider register:', provResp.status, JSON.stringify(provData).slice(0,120));
    await fetch('https://backend.leadconnectorhq.com/payments/custom-provider/webhook', { method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ locationId, webhookUrl: APP_URL + '/api/webhooks/handypay' }) }).catch(() => {});
    return { ok: true };
  } catch(e) { console.error('[activatePaymentModes]', e.message); return { ok: false, error: e.message }; }
}

app.get('/api/health', (req, res) => { res.json({ status: 'ok', ts: new Date().toISOString() }); });

app.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const r = await fetch(GHL_API + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: GHL_CLIENT_ID, client_secret: GHL_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: APP_URL + '/oauth/callback' }) });
    const d = await r.json();
    if (!r.ok) return res.status(400).send('Token exchange failed: ' + JSON.stringify(d));
    const locationId = d.locationId || d.location_id || (state && state.split('_').pop()) || '';
    if (!locationId) return res.status(400).send('No locationId in token response');
    await pool.query('INSERT INTO merchant_configs (location_id,crm_access_token,crm_refresh_token) VALUES ($1,$2,$3) ON CONFLICT (location_id) DO UPDATE SET crm_access_token=$2,crm_refresh_token=$3,updated_at=NOW()', [locationId, d.access_token, d.refresh_token]);
    await activatePaymentModes(locationId, d.access_token, null, 'test').catch(() => {});
    res.redirect(APP_URL + '/api/settings?location_id=' + locationId + '&installed=true');
  } catch(e) { res.status(500).send('OAuth error: ' + e.message); }
});

app.get('/p/:code', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT full_url FROM short_links WHERE code=$1', [req.params.code]);
    if (!rows[0]) return res.status(404).send('Link not found or expired');
    return res.redirect(302, rows[0].full_url);
  } catch(e) { return res.status(500).send('Error: ' + e.message); }
});

app.get('/cancel', async (req, res) => {
  var sessionId = req.query.session_id || req.query.sessionId || '';
  if (sessionId) { try { await updatePaymentLogStatus(sessionId, 'cancelled'); } catch(e) {} }
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Payment Cancelled</title><style>body{font-family:-apple-system,sans-serif;background:#fff7f7;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;width:100%;padding:40px;text-align:center}.icon{font-size:64px;margin-bottom:16px}h1{font-size:22px;font-weight:800;color:#b91c1c;margin-bottom:10px}p{font-size:15px;color:#555;line-height:1.6}</style></head><body><div class="card"><div class="icon">&#10060;</div><h1>Payment Cancelled</h1><p>Your payment was not completed.</p><p>Please use the link in your SMS to try again.</p></div><script>try{window.parent.postMessage(JSON.stringify({type:"custom_element_close_response"}),"*");}catch(e){}<\/script></body></html>');
});

// CRM WEBHOOK (GHL-native v2): no SMS, writes fields + tag, GHL workflow sends SMS
app.post('/api/webhooks/crm', async (req, res) => {
  var rawBody = req.body; var body;
  try { body = typeof rawBody==='string' ? JSON.parse(rawBody) : (Buffer.isBuffer(rawBody) ? JSON.parse(rawBody.toString()) : rawBody); } catch(e) { body = rawBody; }
  console.log('[CRM Webhook]', JSON.stringify(body));
  var locationId = body.locationId||(body.customData&&body.customData.locationId);
  var contactId  = body.contactId || body.contact_id ||(body.customData&&body.customData.contactId);
  var startTime  = body.startTime  ||(body.customData&&body.customData.startTime);
  var title      = body.title      ||(body.customData&&body.customData.title)||'appointment';
  var appointmentTotal = parseFloat(body.appointmentTotal||(body.customData&&body.customData.appointmentTotal)||0);
  if(!locationId||!contactId) return res.json({ok:false,error:'missing_fields'});
  var config = await getMerchantConfig(locationId);
  if(!config) return res.json({ok:false,error:'no_config'});
  var token = config.crm_access_token;
  if(!token) return res.json({ok:false,error:'no_token'});
  var pct = config.deposit_percentage || 30;
  var hasTotal = appointmentTotal > 0;
  var depositAmt = hasTotal ? Math.round(appointmentTotal * pct / 100) : (config.deposit_amount || 0);
  var fullAmt = appointmentTotal;
  var appointmentId = body.appointmentId||(body.customData&&body.customData.appointmentId)||'';
  var meta = { locationId, contactId, title, startTime, appointmentId };
  var depositSession, fullSession;
  try {
    if(hasTotal) {
      var sessions = await Promise.all([
        createHandyPaySession(config.handypay_api_key, depositAmt, pct+'% Deposit - '+title, Object.assign({},meta,{paymentType:'deposit'})),
        createHandyPaySession(config.handypay_api_key, fullAmt, 'Full Payment - '+title, Object.assign({},meta,{paymentType:'full'}))
      ]);
      depositSession = sessions[0]; fullSession = sessions[1];
    } else {
      depositSession = await createHandyPaySession(config.handypay_api_key, depositAmt, 'Deposit - '+title, Object.assign({},meta,{paymentType:'deposit'}));
    }
  } catch(err) { console.error('[HandyPay]',err.message); return res.status(500).json({ok:false,error:'handypay_failed',detail:err.message}); }
  var dLink = await createShortLink(depositSession.url, depositSession.id, locationId, contactId, 'deposit');
  var fLink = fullSession ? await createShortLink(fullSession.url, fullSession.id, locationId, contactId, 'full') : '';
  try {
    await pool.query('INSERT INTO payment_logs (session_id,contact_id,location_id,appointment_id,amount,currency,status,access_token,payment_type,checkout_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (session_id) DO NOTHING', [depositSession.id,contactId,locationId,appointmentId,depositAmt,'jmd','pending',token,'deposit',depositSession.url||null]);
    if(fullSession) await pool.query('INSERT INTO payment_logs (session_id,contact_id,location_id,appointment_id,amount,currency,status,access_token,payment_type,checkout_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (session_id) DO NOTHING', [fullSession.id,contactId,locationId,appointmentId,fullAmt,'jmd','pending',token,'full',fullSession.url||null]);
  } catch(err){ console.error('[DB]',err.message); }
  // Write fields -> triggers GHL Workflow 'Send Deposit Link' which sends the SMS
  try {
    await updateContactField(token, locationId, contactId, { 'contact.deposit_payment_url': dLink, 'contact.deposit_status': 'pending' });
    await addTag(token, contactId, ['hp-deposit-ready']);
    console.log('[CRM Webhook] fields+tag written | contact:', contactId, '| deposit:', depositAmt);
  } catch(err){ console.error('[CRM Webhook] field/tag error:', err.message); }
  res.json({ok:true, depositSessionId:depositSession.id, fullSessionId:fullSession?fullSession.id:null});
});

app.get('/api/init-db', async (req, res) => {
  const secret = req.query.secret || '';
  if(secret !== INIT_SECRET && secret !== 'handypay-init-2026-lnet') return res.status(401).json({error:'unauthorized'});
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS merchant_configs (id SERIAL PRIMARY KEY, location_id TEXT UNIQUE NOT NULL, handypay_api_key TEXT, crm_access_token TEXT, crm_refresh_token TEXT, ghl_access_token TEXT, ghl_refresh_token TEXT, deposit_amount INTEGER DEFAULT 5000, deposit_type TEXT DEFAULT 'percentage', deposit_percentage FLOAT DEFAULT 30, success_url TEXT, cancel_url TEXT, mode TEXT DEFAULT 'test', sms_template TEXT, handypay_webhook_id TEXT, handypay_webhook_secret TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS payment_logs (id SERIAL PRIMARY KEY, session_id TEXT UNIQUE, location_id TEXT, contact_id TEXT, amount INTEGER, currency TEXT DEFAULT 'jmd', status TEXT DEFAULT 'pending', payment_type TEXT DEFAULT 'deposit', checkout_url TEXT, ghl_transaction_id TEXT, entity_id TEXT, appointment_id TEXT, appointment_id_v2 TEXT, access_token TEXT, record_payment_done BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS short_links (id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, full_url TEXT NOT NULL, session_id TEXT, location_id TEXT, contact_id TEXT, payment_type TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS debug_messages (id SERIAL PRIMARY KEY, location_id TEXT, message TEXT, origin TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    res.json({ ok: true, ts: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.all('/api/query', async (req, res) => { return res.status(404).json({ message: 'Use /api/query standalone function' }); });

app.all('/api/pay', async (req, res) => {
  var locationId=req.query.locationId||req.query.location_id||(req.body&&(req.body.locationId||req.body.location_id))||'', amountRaw=req.query.amount||(req.body&&req.body.amount)||0, amountJMD=Math.round(parseFloat(amountRaw)||0), contactId=req.query.contactId||(req.body&&req.body.contactId)||'', entityId=req.query.entityId||req.query.ghlTransactionId||(req.body&&(req.body.entityId||req.body.ghlTransactionId))||'';
  if(!locationId) return res.status(400).json({ok:false,error:'missing locationId'});
  var cfg=await getMerchantConfig(locationId).catch(()=>null);
  if(!cfg||!cfg.handypay_api_key) return res.status(400).json({ok:false,error:'not_configured'});
  try {
    var session=await createHandyPaySession(cfg.handypay_api_key,amountJMD,'HandyPay Payment',{contact_id:contactId,location_id:locationId,entity_id:entityId,payment_type:'ghl_native'},true);
    var sessionId=session.id, checkoutUrl=session.url||'';
    await pool.query('INSERT INTO payment_logs (session_id,location_id,contact_id,amount,currency,status,payment_type,checkout_url) VALUES ($1,$2,$3,$4,$5,\'pending\',\'ghl_native\',$6) ON CONFLICT (session_id) DO NOTHING',[sessionId,locationId,contactId,Math.round(amountJMD),checkoutUrl]);
    return res.json({ paymentIntentId: sessionId, checkoutUrl });
  } catch(e) { console.error('[/api/pay]',e.message); return res.status(500).json({ok:false,error:e.message}); }
});

app.post('/api/webhooks/handypay', (req, res) => { res.status(404).json({ message: 'Use standalone function' }); });

app.get('/api/debug-token', async (req, res) => {
  const locationId=req.query.location_id||req.query.locationId||'';
  if(!locationId) return res.status(400).json({error:'location_id required'});
  try {
    const cfg=await getMerchantConfig(locationId);
    if(!cfg) return res.json({found:false});
    res.json({found:true,has_pit:!!(cfg.crm_access_token&&!cfg.crm_refresh_token),has_oauth:!!(cfg.crm_access_token&&cfg.crm_refresh_token),token_prefix:cfg.crm_access_token?cfg.crm_access_token.substring(0,12)+'...':'none',webhook_id:cfg.handypay_webhook_id||'none'});
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/debug-log', async (req, res) => {
  const locationId=req.query.location_id||req.query.locationId||'', limit=Math.min(parseInt(req.query.limit)||20,100);
  try {
    const {rows}=locationId?await pool.query('SELECT * FROM debug_messages WHERE location_id=$1 ORDER BY created_at DESC LIMIT $2',[locationId,limit]):await pool.query('SELECT * FROM debug_messages ORDER BY created_at DESC LIMIT $1',[limit]);
    res.json({count:rows.length,messages:rows});
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl-order', async (req, res) => {
  const {locationId,orderId}=req.query;
  if(!locationId||!orderId) return res.status(400).json({error:'locationId and orderId required'});
  try { const token=await getFreshToken(locationId); const r=await fetch(GHL_API+'/payments/orders/'+orderId+'?altId='+encodeURIComponent(locationId)+'&altType=location',{headers:{'Authorization':'Bearer '+token,'Version':'2021-07-28'}}); const d=await r.json(); res.json(d); }
  catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/cron-retry', async (req, res) => {
  const secret=req.query.secret||req.headers['x-secret']||'';
  if(secret!==INIT_SECRET&&secret!=='handypay-init-2026-lnet') return res.status(401).json({error:'unauthorized'});
  try {
    const {rows}=await pool.query('SELECT pl.session_id,pl.location_id,pl.amount,pl.entity_id,pl.appointment_id FROM payment_logs pl WHERE pl.status=\'paid\' AND pl.record_payment_done=FALSE AND pl.payment_type=\'ghl_native\' AND pl.created_at>NOW()-INTERVAL \'7 days\' LIMIT 10');
    let fixed=0;
    for(const row of rows){
      try { const tok=await getFreshToken(row.location_id); const invId=row.entity_id||row.appointment_id||''; if(!invId) continue; await fireRecordPayment(invId,row.location_id,row.amount,'HandyPay-cron:'+row.session_id,tok); await pool.query('UPDATE payment_logs SET record_payment_done=TRUE WHERE session_id=$1',[row.session_id]); fixed++; }
      catch(e){console.error('[cron-retry] failed:',row.session_id,e.message);}
    }
    res.json({ok:true,fixed,checked:rows.length});
  } catch(eCron){return res.status(500).json({error:eCron.message});}
});

module.exports = app;
