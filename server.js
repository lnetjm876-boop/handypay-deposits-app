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
    res.redirect('/api/settings?location_id=' + tokens.locationId + '&installed=true');
  } catch (err) { res.status(500).send('OAuth error: ' + err.message); }
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
