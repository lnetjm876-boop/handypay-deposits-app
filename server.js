const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const app = express();
app.use('/api/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
app.get('/', (req, res) => res.json({ status: 'ok', service: 'HandyPay Deposits v1.0' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.get('/api/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const t = await fetch('https://services.leadconnectorhq.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GHL_CLIENT_ID, client_secret: process.env.GHL_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: process.env.APP_URL + '/api/oauth/callback' }) });
    const tokens = await t.json();
    if (!tokens.access_token) return res.status(400).send('Token error: ' + JSON.stringify(tokens));
    await pool.query('INSERT INTO merchant_configs (location_id,crm_access_token,crm_refresh_token) VALUES ($1,$2,$3) ON CONFLICT (location_id) DO UPDATE SET crm_access_token=$2,crm_refresh_token=$3,updated_at=NOW()', [tokens.locationId, tokens.access_token, tokens.refresh_token]);
    try {
      const provRes = await fetch('https://services.leadconnectorhq.com/payments/custom-provider/provider?locationId=' + tokens.locationId, { method: 'POST', headers: { 'Authorization': 'Bearer ' + tokens.access_token, 'Content-Type': 'application/json', 'Version': '2021-07-28' }, body: JSON.stringify({ name: 'HandyPay Deposits', description: 'Collect booking deposits automatically. Clients get an SMS payment link when they book.', paymentsUrl: process.env.APP_URL + '/api/pay', queryUrl: process.env.APP_URL + '/api/query', imageUrl: process.env.APP_URL + '/api/logo', supportsSubscriptionSchedule: false }) });
      const provData = await provRes.json();
      console.log('Payment provider registered:', JSON.stringify(provData));
    } catch (provErr) { console.error('Provider registration failed (non-fatal):', provErr.message); }
    res.redirect('/api/settings?location_id=' + tokens.locationId + '&installed=true');
  } catch (err) { res.status(500).send('OAuth error: ' + err.message); }
});
app.get('/api/logo', (req, res) => { res.redirect('https://img.icons8.com/color/200/hand-holding-dollar.png'); });
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
app.get('/api/settings', async (req, res) => {
  const { location_id } = req.query;
  if (!location_id) return res.status(400).send('Missing location_id');
  let c = {};
  try { const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [location_id]); if (rows.length) c = rows[0]; } catch(e){}
  const msg = req.query.installed ? 'Installed!' : req.query.saved ? 'Saved!' : '';
  res.send('<html><head><title>HandyPay Deposits</title><style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px}h1{color:#005DBD}label{display:block;font-weight:600;margin-top:14px}input,select{width:100%;padding:9px;border:1px solid #ddd;border-radius:5px;margin-top:4px}button{background:#005DBD;color:#fff;padding:11px 24px;border:none;border-radius:5px;cursor:pointer;margin-top:20px}</style></head><body><h1>HandyPay Deposits</h1>' + (msg ? '<p style="color:green">' + msg + '</p>' : '') + '<form method="POST" action="/api/settings"><input type="hidden" name="location_id" value="' + location_id + '"><label>HandyPay API Key</label><input name="handypay_api_key" value="' + (c.handypay_api_key || '') + '" placeholder="hp_live_..."><label>Deposit Amount (JMD)</label><input type="number" name="deposit_amount" value="' + (c.deposit_amount || 5000) + '"><label>Type</label><select name="deposit_type"><option value="fixed">Fixed</option><option value="percentage">Percentage</option></select><label>Success URL</label><input name="success_url" value="' + (c.success_url || '') + '"><label>Cancel URL</label><input name="cancel_url" value="' + (c.cancel_url || '') + '"><button>Save</button></form></body></html>');
});
app.post('/api/settings', async (req, res) => {
  const { location_id, handypay_api_key, deposit_amount, deposit_type, success_url, cancel_url } = req.body;
  if (!location_id) return res.status(400).send('Missing location_id');
  try { await pool.query('INSERT INTO merchant_configs (location_id,handypay_api_key,deposit_amount,deposit_type,success_url,cancel_url) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (location_id) DO UPDATE SET handypay_api_key=$2,deposit_amount=$3,deposit_type=$4,success_url=$5,cancel_url=$6,updated_at=NOW()', [location_id, handypay_api_key, parseInt(deposit_amount) || 5000, deposit_type, success_url, cancel_url]); res.redirect('/api/settings?location_id=' + location_id + '&saved=true'); } catch(err){ res.status(500).send(err.message); }
});
app.post('/api/webhooks/handypay', async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
  const sig = req.headers['handypay-signature'] || req.headers['stripe-signature'] || '';
  if (process.env.HANDYPAY_WEBHOOK_SECRET && sig) { const exp = crypto.createHmac('sha256', process.env.HANDYPAY_WEBHOOK_SECRET).update(raw).digest('hex'); const sv = sig.includes('=') ? sig.split('=').pop() : sig; if (sv !== exp) return res.status(401).json({ error: 'Bad signature' }); }
  const event = Buffer.isBuffer(req.body) ? JSON.parse(raw) : req.body;
  console.log('HP event:', event.type);
  try {
    const s = event.data?.object || event.data || {}, m = s.metadata || {};
    if (m.location_id && m.contact_id && (event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded')) {
      const { rows } = await pool.query('SELECT crm_access_token FROM merchant_configs WHERE location_id=$1', [m.location_id]);
      if (rows.length && rows[0].crm_access_token) {
        const tok = rows[0].crm_access_token, amt = ((s.amount_total || s.amount || 0) / 100).toLocaleString();
        await fetch('https://services.leadconnectorhq.com/contacts/' + m.contact_id + '/notes', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json', 'Version': '2021-07-28' }, body: JSON.stringify({ body: 'Deposit received: JMD $' + amt + ' | ID: ' + s.id + ' | ' + new Date().toLocaleString() }) });
        await fetch('https://services.leadconnectorhq.com/contacts/' + m.contact_id + '/tags', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json', 'Version': '2021-07-28' }, body: JSON.stringify({ tags: ['deposit-paid'] }) });
        await pool.query('INSERT INTO payment_logs (location_id,contact_id,payment_id,amount_jmd,event_type) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [m.location_id, m.contact_id, s.id, s.amount_total || s.amount || 0, event.type]);
      }
    }
    if (event.type === 'charge.refunded' && m.location_id && m.contact_id) { const { rows } = await pool.query('SELECT crm_access_token FROM merchant_configs WHERE location_id=$1', [m.location_id]); if (rows.length) await fetch('https://services.leadconnectorhq.com/contacts/' + m.contact_id + '/tags', { method: 'POST', headers: { 'Authorization': 'Bearer ' + rows[0].crm_access_token, 'Content-Type': 'application/json', 'Version': '2021-07-28' }, body: JSON.stringify({ tags: ['deposit-refunded'] }) }); }
  } catch(err){ console.error('HP webhook err:', err); }
  res.json({ received: true });
});
app.post('/api/webhooks/crm', async (req, res) => {
  const e = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
  if (e.type !== 'AppointmentCreate') return res.json({ skipped: e.type });
  try {
    const locId = e.locationId, conId = e.contactId || e.contact?.id, fn = e.contact?.firstName || 'there', title = e.appointment?.title || 'Your Appointment';
    const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [locId]);
    if (!rows.length || !rows[0].handypay_api_key) return res.json({ skipped: 'no-config' });
    const cfg = rows[0], dep = cfg.deposit_amount || 5000;
    const sr = await fetch('https://api.handypay.me/api/v1/payment-sessions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + cfg.handypay_api_key, 'Content-Type': 'application/json' }, body: JSON.stringify({ line_items: [{ name: 'Deposit - ' + title, amount: dep * 100, currency: 'jmd', quantity: 1 }], customer_email: e.contact?.email || undefined, success_url: cfg.success_url || process.env.APP_URL + '/success', cancel_url: cfg.cancel_url || process.env.APP_URL + '/cancel', metadata: { location_id: locId, contact_id: conId, appointment_title: title } }) });
    const sess = await sr.json();
    if ((sess.data?.url || sess.url) && cfg.crm_access_token) {
      const smsMsg = 'Hi ' + fn + '! Pay your deposit (JMD $' + dep.toLocaleString() + ') to confirm ' + title + ': ' + (sess.data?.url || sess.url) + ' - Link expires in 24 hours.';
      await fetch('https://services.leadconnectorhq.com/conversations/messages', { method: 'POST', headers: { 'Authorization': 'Bearer ' + cfg.crm_access_token, 'Content-Type': 'application/json', 'Version': '2021-04-15' }, body: JSON.stringify({ type: 'SMS', contactId: conId, message: smsMsg }) });
      await fetch('https://services.leadconnectorhq.com/contacts/' + conId + '/notes', { method: 'POST', headers: { 'Authorization': 'Bearer ' + cfg.crm_access_token, 'Content-Type': 'application/json', 'Version': '2021-07-28' }, body: JSON.stringify({ body: 'Deposit link sent: JMD $' + dep.toLocaleString() + ' | Session: ' + (sess.data?.id || sess.id) }) });
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
    if (type === 'subscription' && price_id) { ep = 'https://api.handypay.me/api/v1/subscription-sessions'; body = { price_id, success_url: cfg.success_url || process.env.APP_URL + '/success', cancel_url: cfg.cancel_url || process.env.APP_URL + '/cancel', metadata: { location_id, contact_id } }; }
    else { ep = 'https://api.handypay.me/api/v1/payment-sessions'; body = { line_items: [{ name: description || 'Deposit Payment', amount: dep * 100, currency: 'jmd', quantity: 1 }], success_url: cfg.success_url || process.env.APP_URL + '/success', cancel_url: cfg.cancel_url || process.env.APP_URL + '/cancel', metadata: { location_id, contact_id } }; }
    const sr = await fetch(ep, { method: 'POST', headers: { 'Authorization': 'Bearer ' + cfg.handypay_api_key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const sess = await sr.json();
    res.json({ url: sess.data?.url || sess.url, session_id: sess.data?.id || sess.id, amount_jmd: dep });
  } catch(err){ res.status(500).json({ error: err.message }); }
});
app.get('/api/init-db', async (req, res) => {
  if ((req.headers['x-init-secret'] || req.query.secret) !== process.env.INIT_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS merchant_configs (id SERIAL PRIMARY KEY,location_id VARCHAR(100) UNIQUE NOT NULL,handypay_api_key TEXT,crm_access_token TEXT,crm_refresh_token TEXT,deposit_amount INTEGER DEFAULT 5000,deposit_type VARCHAR(20) DEFAULT 'fixed',success_url TEXT,cancel_url TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW()); CREATE TABLE IF NOT EXISTS payment_logs (id SERIAL PRIMARY KEY,location_id VARCHAR(100),contact_id VARCHAR(100),payment_id TEXT UNIQUE,amount_jmd INTEGER,event_type VARCHAR(50),created_at TIMESTAMPTZ DEFAULT NOW()); CREATE INDEX IF NOT EXISTS idx_mc_loc ON merchant_configs(location_id); CREATE INDEX IF NOT EXISTS idx_pl_loc ON payment_logs(location_id);");
    res.json({ ok: true, message: 'DB initialized.' });
  } catch(err){ res.status(500).json({ error: err.message }); }
});
app.get('/success', (req, res) => res.send('<html><body style="text-align:center;font-family:sans-serif;padding:60px"><h1 style="color:#28a745">Deposit Received!</h1><p>Booking confirmed.</p></body></html>'));
app.get('/cancel', (req, res) => res.send('<html><body style="text-align:center;font-family:sans-serif;padding:60px"><h1 style="color:#dc3545">Cancelled</h1><p>No charge made.</p></body></html>'));
app.listen(process.env.PORT || 3000, () => console.log('HandyPay Deposits running'));
module.exports = app;
