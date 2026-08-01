const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const app = express();
const GHL_API = 'https://services.leadconnectorhq.com';
const HP_BASE = 'https://api.handypay.me/api/v1';

app.use('/api/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const LOGO_URL = 'https://storage.googleapis.com/crm-conversations-ai-production/ask-ai-images/1785549533996/aaf88bbe-7f89-44b6-ba1b-12a6417755f6.png';

app.get('/', (req, res) => res.json({ status: 'ok', service: 'HandyPay Deposits v1.0' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.get('/api/logo', (req, res) => res.redirect(LOGO_URL));

async function registerPaymentProvider(locationId, accessToken) {
  try {
    const r = await fetch(GHL_API + '/payments/custom-provider/provider?locationId=' + locationId, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
      body: JSON.stringify({ name: 'HandyPay Deposits', description: 'Collect booking deposits automatically. Clients get an SMS payment link when they book.', paymentsUrl: process.env.APP_URL + '/api/pay', queryUrl: process.env.APP_URL + '/api/query', imageUrl: LOGO_URL, supportsSubscriptionSchedule: false })
    });
    const d = await r.json();
    console.log('[register]', locationId, r.status, JSON.stringify(d).substring(0,300));
    return d;
  } catch (e) { console.error('[register] error:', e.message); }
}

async function activatePaymentModes(locationId, accessToken, apiKey, mode) {
  const isLive = mode === 'live';
  const key = apiKey || 'hp_pending_setup';
  try {
    const r = await fetch(GHL_API + '/payments/custom-provider/connect?locationId=' + locationId, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
      body: JSON.stringify({ locationId, live: { apiKey: key, publishableKey: key, liveMode: isLive }, test: { apiKey: key, publishableKey: key, liveMode: !isLive } })
    });
    const d = await r.json();
    console.log('[activate]', locationId, mode, r.status, JSON.stringify(d).substring(0,300));
    return d;
  } catch (e) { console.error('[activate] error:', e.message); }
}

app.get('/api/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const t = await fetch(GHL_API + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.GHL_CLIENT_ID, client_secret: process.env.GHL_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: process.env.APP_URL + '/api/oauth/callback' })
    });
    const tokens = await t.json();
    console.log('OAuth response:', JSON.stringify({ keys: Object.keys(tokens), userType: tokens.userType, locationId: tokens.locationId, companyId: tokens.companyId, hasToken: !!tokens.access_token }));
    if (!tokens.access_token) return res.status(400).send('Token error: ' + JSON.stringify(tokens));
    const locationId = tokens.locationId || null;
    if (!locationId) {
      console.error('Company-level token received - no locationId. userType:', tokens.userType);
      return res.send('<html><head><title>HandyPay Deposits</title><style>body{font-family:sans-serif;max-width:600px;margin:60px auto;padding:20px;text-align:center}h2{color:#D10039}p{color:#444}.note{color:#888;font-size:12px;margin-top:20px}</style></head><body><h2>Sub-Account Install Required</h2><p>HandyPay Deposits must be installed <strong>per sub-account</strong>, not at the agency level.</p><p>Please use the sub-account install link provided by L-NET, or contact support.</p><p class="note">Debug: userType=' + tokens.userType + ' | companyId=' + tokens.companyId + '</p></body></html>');
    }
    await pool.query('INSERT INTO merchant_configs (location_id,crm_access_token,crm_refresh_token) VALUES ($1,$2,$3) ON CONFLICT (location_id) DO UPDATE SET crm_access_token=$2,crm_refresh_token=$3,updated_at=NOW()', [locationId, tokens.access_token, tokens.refresh_token]);
    await registerPaymentProvider(locationId, tokens.access_token);
    await activatePaymentModes(locationId, tokens.access_token, 'hp_pending_setup', 'test');
    res.redirect('/api/settings?location_id=' + locationId + '&installed=true');
  } catch (err) {
    res.status(500).send('OAuth error: ' + err.message);
  }
});

app.get('/api/settings', async (req, res) => {
  const { location_id } = req.query;
  if (!location_id) return res.status(400).send('Missing location_id');
  let c = {};
  try { const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [location_id]); if (rows.length) c = rows[0]; } catch(e){}
  const msg = req.query.installed ? 'App installed! Enter your HandyPay API key below to activate deposits.' : req.query.saved ? 'Settings saved! HandyPay is now connected.' : '';
  const isConn = !!c.handypay_api_key && c.handypay_api_key !== 'hp_pending_setup';
  const masked = isConn ? c.handypay_api_key.slice(0,14) + '...' + c.handypay_api_key.slice(-4) : '';
  const curMode = c.mode || 'test';
  res.send('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandyPay Deposits</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f4f6fb;padding:24px}.card{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.09);max-width:560px;margin:0 auto;padding:40px}.hdr{display:flex;align-items:center;gap:14px;margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid #f0f0f0}.hdr img{width:48px;height:48px;border-radius:10px}.hdr h1{font-size:20px;font-weight:800;color:#005DBD}.hdr span{font-size:12px;color:#999}.ok{background:#e8f5e9;border:1px solid #a5d6a7;color:#2e7d32;padding:12px 16px;border-radius:8px;font-size:14px;margin-bottom:20px}.badge{background:#e3f2fd;border:1px solid #90caf9;color:#1565c0;padding:8px 14px;border-radius:8px;font-size:13px;margin-bottom:18px}label{display:block;font-size:13px;font-weight:700;color:#333;margin-top:16px;margin-bottom:5px}input,select{width:100%;border:1.5px solid #e0e0e0;border-radius:8px;padding:10px 14px;font-size:14px;color:#222;outline:none}.hr{border:none;border-top:1px solid #f0f0f0;margin:20px 0}.chk-row{display:flex;align-items:flex-start;gap:12px;margin-top:16px;padding:14px;background:#f8f9ff;border-radius:10px;border:1px solid #e0e8ff}.chk-row input[type=checkbox]{width:18px;height:18px;margin-top:2px;accent-color:#005DBD;flex-shrink:0}.chk-row div label{font-size:14px;font-weight:700;margin:0;cursor:pointer}.chk-row div p{font-size:12px;color:#888;margin-top:3px}.btn{width:100%;margin-top:24px;background:#D10039;color:#fff;border:none;border-radius:9px;padding:14px;font-size:15px;font-weight:700;cursor:pointer}.foot{margin-top:16px;text-align:center;font-size:11px;color:#ccc}</style></head><body><div class="card"><div class="hdr"><img src="' + process.env.APP_URL + '/api/logo" alt="HandyPay"><div><h1>HandyPay Deposits</h1><span>Payment Integration Settings</span></div></div>' + (msg ? '<div class="ok">' + msg + '</div>' : '') + (isConn ? '<div class="badge">Connected | Key: <code>' + masked + '</code> | Mode: <strong>' + curMode.toUpperCase() + '</strong></div>' : '') + '<form method="POST" action="/api/settings"><input type="hidden" name="location_id" value="' + location_id + '"><label>HandyPay API Key *</label><input type="text" name="handypay_api_key" value="' + (isConn ? c.handypay_api_key : '') + '" placeholder="' + (curMode === 'live' ? 'hp_live_...' : 'hp_test_...') + '" required autocomplete="off"><label>Payment Mode</label><select name="mode"><option value="test"' + (curMode !== 'live' ? ' selected' : '') + '>&#x1F9EA; Test Mode (hp_test_... keys)</option><option value="live"' + (curMode === 'live' ? ' selected' : '') + '>&#x1F534; Live Mode (hp_live_... keys)</option></select><div class="hr"></div><label>Deposit Amount (JMD)</label><input type="number" name="deposit_amount" value="' + (c.deposit_amount || 5000) + '" min="100" step="100"><label>Type</label><select name="deposit_type"><option value="fixed">Fixed</option><option value="percentage">Percentage</option></select><label>Success URL <span style="font-weight:normal;color:#aaa">(optional)</span></label><input type="text" name="success_url" value="' + (c.success_url || '') + '" placeholder="https://yourdomain.com/thank-you"><label>Cancel URL <span style="font-weight:normal;color:#aaa">(optional)</span></label><input type="text" name="cancel_url" value="' + (c.cancel_url || '') + '" placeholder="https://yourdomain.com/cancelled"><div class="hr"></div><div class="chk-row"><input type="checkbox" name="set_default" id="sd" value="1"><div><label for="sd">Set as Default Payment Provider</label><p>Make HandyPay the primary provider for calendar bookings and online payments</p></div></div><button type="submit" class="btn">Save &amp; Connect HandyPay</button></form><div class="foot">HandyPay Deposits v1.0 &middot; L-NET Smart Technologies</div></div></body></html>');
});

app.post('/api/settings', async (req, res) => {
  const { location_id, handypay_api_key, deposit_amount, deposit_type, success_url, cancel_url, mode, set_default } = req.body;
  if (!location_id) return res.status(400).send('Missing location_id');
  try {
    await pool.query('INSERT INTO merchant_configs (location_id,handypay_api_key,deposit_amount,deposit_type,success_url,cancel_url,mode,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) ON CONFLICT (location_id) DO UPDATE SET handypay_api_key=$2,deposit_amount=$3,deposit_type=$4,success_url=$5,cancel_url=$6,mode=$7,updated_at=NOW()', [location_id, handypay_api_key, parseInt(deposit_amount)||5000, deposit_type||'fixed', success_url||'', cancel_url||'', mode||'test']);
    const { rows } = await pool.query('SELECT crm_access_token FROM merchant_configs WHERE location_id=$1', [location_id]);
    if (rows[0] && rows[0].crm_access_token) {
      await registerPaymentProvider(location_id, rows[0].crm_access_token);
        await activatePaymentModes(location_id, rows[0].crm_access_token, handypay_api_key, mode || 'test');
      if (set_default === '1') {
        try {
          await fetch(GHL_API + '/payments/custom-provider/provider?locationId=' + location_id, { method: 'POST', headers: { 'Authorization': 'Bearer ' + rows[0].crm_access_token, 'Content-Type': 'application/json', 'Version': '2021-07-28' }, body: JSON.stringify({ name: 'HandyPay Deposits', description: 'Collect booking deposits automatically.', paymentsUrl: process.env.APP_URL + '/api/pay', queryUrl: process.env.APP_URL + '/api/query', imageUrl: LOGO_URL, supportsSubscriptionSchedule: false, isDefault: true }) });
          console.log('[set-default] attempted for', location_id);
        } catch(e) { console.error('[set-default] error:', e.message); }
      }
    } else {
      console.warn('[settings] No CRM token for', location_id, '- re-run OAuth install to store it');
    }
    res.redirect('/api/settings?location_id=' + location_id + '&saved=true');
  } catch(err) { res.status(500).send(err.message); }
});

app.get('/api/pay', async (req, res) => {
  const { locationId } = req.query;
  let cfg = {};
  try { const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [locationId]); if (rows.length) cfg = rows[0]; } catch(e){}
  const dep = cfg.deposit_amount || 5000;
  res.send('<html><head><title>HandyPay Deposit</title><style>body{font-family:sans-serif;max-width:500px;margin:40px auto;padding:20px;text-align:center}h2{color:#005DBD}.btn{background:#D10039;color:#fff;padding:12px 28px;border:none;border-radius:6px;font-size:16px;cursor:pointer;margin-top:20px;text-decoration:none;display:inline-block}</style></head><body><h2>HandyPay Deposits</h2><p>Deposit Amount: <strong>JMD $' + dep.toLocaleString() + '</strong></p><p style="color:#888;font-size:13px">A payment link will be sent via SMS to the client when an appointment is booked.</p><a class="btn" href="https://handypay.me" target="_blank">Open HandyPay Dashboard</a></body></html>');
});

app.post('/api/query', async (req, res) => {
  const body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
  console.log('CRM payment query:', JSON.stringify(body));
  res.json({ status: 'ok', received: true });
});

app.get('/api/settings', async (req, res) => { });

app.post('/api/webhooks/handypay', async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
  const sig = req.headers['handypay-signature'] || req.headers['stripe-signature'] || '';
  if (process.env.HANDYPAY_WEBHOOK_SECRET && sig) {
    const exp = crypto.createHmac('sha256', process.env.HANDYPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    const sv = sig.includes('=') ? sig.split('=').pop() : sig;
    if (sv !== exp) return res.status(401).json({ error: 'Bad signature' });
  }
  const event = Buffer.isBuffer(req.body) ? JSON.parse(raw) : req.body;
  console.log('HP event:', event.type);
  try {
    const s = event.data && event.data.object || event.data || {}, m = s.metadata || {};
    if (m.location_id && m.contact_id && (event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded')) {
      const { rows } = await pool.query('SELECT crm_access_token FROM merchant_configs WHERE location_id=$1', [m.location_id]);
      if (rows.length && rows[0].crm_access_token) {
        const tok = rows[0].crm_access_token, amt = ((s.amount_total || s.amount || 0) / 100).toLocaleString();
        await fetch(GHL_API + '/contacts/' + m.contact_id + '/notes', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json', 'Version': '2021-07-28' }, body: JSON.stringify({ body: 'Deposit received: JMD $' + amt + ' | ID: ' + s.id + ' | ' + new Date().toLocaleString() }) });
        await fetch(GHL_API + '/contacts/' + m.contact_id + '/tags', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json', 'Version': '2021-07-28' }, body: JSON.stringify({ tags: ['deposit-paid'] }) });
        await pool.query('INSERT INTO payment_logs (location_id,contact_id,payment_id,amount_jmd,event_type) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [m.location_id, m.contact_id, s.id, s.amount_total || s.amount || 0, event.type]);
      }
    }
    if (event.type === 'charge.refunded' && m.location_id && m.contact_id) {
      const { rows } = await pool.query('SELECT crm_access_token FROM merchant_configs WHERE location_id=$1', [m.location_id]);
      if (rows.length) await fetch(GHL_API + '/contacts/' + m.contact_id + '/tags', { method: 'POST', headers: { 'Authorization': 'Bearer ' + rows[0].crm_access_token, 'Content-Type': 'application/json', 'Version': '2021-07-28' }, body: JSON.stringify({ tags: ['deposit-refunded'] }) });
    }
  } catch(err){ console.error('HP webhook err:', err); }
  res.json({ received: true });
});

app.post('/api/webhooks/crm', async (req, res) => {
  const e = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
  if (e.type !== 'AppointmentCreate') return res.json({ skipped: e.type });
  try {
    const locId = e.locationId, conId = e.contactId || e.contact && e.contact.id;
    const fn = e.contact && e.contact.firstName || 'there', title = e.appointment && e.appointment.title || 'Your Appointment';
    const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [locId]);
    if (!rows.length || !rows[0].handypay_api_key || rows[0].handypay_api_key === 'hp_pending_setup') return res.json({ skipped: 'no-config' });
    const cfg = rows[0], dep = cfg.deposit_amount || 5000;
    const sr = await fetch(HP_BASE + '/payment-sessions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + cfg.handypay_api_key, 'Content-Type': 'application/json' }, body: JSON.stringify({ line_items: [{ name: 'Deposit - ' + title, amount: dep * 100, currency: 'jmd', quantity: 1 }], customer_email: e.contact && e.contact.email || undefined, success_url: cfg.success_url || process.env.APP_URL + '/success', cancel_url: cfg.cancel_url || process.env.APP_URL + '/cancel', metadata: { location_id: locId, contact_id: conId, appointment_title: title } }) });
    const sess = await sr.json();
    if ((sess.data && sess.data.url || sess.url) && cfg.crm_access_token) {
      const link = sess.data && sess.data.url || sess.url;
      const smsMsg = 'Hi ' + fn + '! Pay your deposit (JMD $' + dep.toLocaleString() + ') to confirm ' + title + ': ' + link + ' - Link expires in 24 hours.';
      await fetch(GHL_API + '/conversations/messages', { method: 'POST', headers: { 'Authorization': 'Bearer ' + cfg.crm_access_token, 'Content-Type': 'application/json', 'Version': '2021-04-15' }, body: JSON.stringify({ type: 'SMS', contactId: conId, message: smsMsg }) });
      await fetch(GHL_API + '/contacts/' + conId + '/notes', { method: 'POST', headers: { 'Authorization': 'Bearer ' + cfg.crm_access_token, 'Content-Type': 'application/json', 'Version': '2021-07-28' }, body: JSON.stringify({ body: 'Deposit link sent: JMD $' + dep.toLocaleString() + ' | Session: ' + (sess.data && sess.data.id || sess.id) }) });
    }
  } catch(err){ console.error('CRM webhook err:', err); }
  res.json({ received: true });
});

app.post('/api/session', async (req, res) => {
  const { location_id, contact_id, amount, description, type = 'one_time', price_id } = req.body;
  if (!location_id || !contact_id) return res.status(400).json({ error: 'location_id and contact_id required' });
  try {
    const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [location_id]);
    if (!rows.length || !rows[0].handypay_api_key) return res.status(404).json({ error: 'Not configured' });
    const cfg = rows[0], dep = amount || cfg.deposit_amount || 5000;
    let ep, body;
    if (type === 'subscription' && price_id) {
      ep = HP_BASE + '/subscription-sessions';
      body = { price_id, success_url: cfg.success_url || process.env.APP_URL + '/success', cancel_url: cfg.cancel_url || process.env.APP_URL + '/cancel', metadata: { location_id, contact_id } };
    } else {
      ep = HP_BASE + '/payment-sessions';
      body = { line_items: [{ name: description || 'Deposit Payment', amount: dep * 100, currency: 'jmd', quantity: 1 }], success_url: cfg.success_url || process.env.APP_URL + '/success', cancel_url: cfg.cancel_url || process.env.APP_URL + '/cancel', metadata: { location_id, contact_id } };
    }
    const sr = await fetch(ep, { method: 'POST', headers: { 'Authorization': 'Bearer ' + cfg.handypay_api_key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const sess = await sr.json();
    res.json({ url: sess.data && sess.data.url || sess.url, session_id: sess.data && sess.data.id || sess.id, amount_jmd: dep });
  } catch(err){ res.status(500).json({ error: err.message }); }
});

app.get('/api/init-db', async (req, res) => {
  if ((req.headers['x-init-secret'] || req.query.secret) !== process.env.INIT_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS merchant_configs (id SERIAL PRIMARY KEY,location_id VARCHAR(100) UNIQUE NOT NULL,handypay_api_key TEXT,crm_access_token TEXT,crm_refresh_token TEXT,deposit_amount INTEGER DEFAULT 5000,deposit_type VARCHAR(20) DEFAULT 'fixed',mode VARCHAR(10) DEFAULT 'test',success_url TEXT,cancel_url TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW()); ALTER TABLE merchant_configs ADD COLUMN IF NOT EXISTS mode VARCHAR(10) DEFAULT 'test'; CREATE TABLE IF NOT EXISTS payment_logs (id SERIAL PRIMARY KEY,location_id VARCHAR(100),contact_id VARCHAR(100),payment_id TEXT UNIQUE,amount_jmd INTEGER,event_type VARCHAR(50),created_at TIMESTAMPTZ DEFAULT NOW()); CREATE INDEX IF NOT EXISTS idx_mc_loc ON merchant_configs(location_id); CREATE INDEX IF NOT EXISTS idx_pl_loc ON payment_logs(location_id);");
    res.json({ ok: true, message: 'DB initialized.' });
  } catch(err){ res.status(500).json({ error: err.message }); }
});

app.get('/success', (req, res) => res.send('<html><body style="text-align:center;font-family:sans-serif;padding:60px"><h1 style="color:#28a745">Deposit Received!</h1><p>Booking confirmed.</p></body></html>'));
app.get('/cancel', (req, res) => res.send('<html><body style="text-align:center;font-family:sans-serif;padding:60px"><h1 style="color:#dc3545">Cancelled</h1><p>No charge made.</p></body></html>'));

app.listen(process.env.PORT || 3000, () => console.log('HandyPay Deposits running'));
module.exports = app;
