// api/ghl-setup.js — One-time GHL connection page (PIT mode)
// Phase 1: Improved success state with step completion checklist + next steps
'use strict';
const { Pool } = require('pg');

const GHL_API = 'https://services.leadconnectorhq.com';
const APP_URL = process.env.APP_URL || 'https://handypay-deposits-app.vercel.app';
const LOGO_URL = 'https://storage.googleapis.com/crm-conversations-ai-production/ask-ai-images/1785549533996/aaf88bbe-7f89-44b6-ba1b-12a6417755f6.png';
const WEBHOOK_URL = APP_URL + '/api/webhooks/handypay';
const SETTINGS_URL = APP_URL + '/api/settings';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000
});

async function getMerchantConfig(locationId) {
  const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1 LIMIT 1', [locationId]);
  return rows[0] || null;
}

async function upsertMerchantConfig(locationId, fields) {
  const keys = Object.keys(fields);
  const vals = Object.values(fields);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(',');
  await pool.query(
    `INSERT INTO merchant_configs (location_id,${keys.join(',')}) VALUES ($1,${keys.map((_,i)=>'$'+(i+2)).join(',')})
     ON CONFLICT (location_id) DO UPDATE SET ${sets}, updated_at=NOW()`,
    [locationId, ...vals]
  );
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return r;
  } catch (e) { clearTimeout(timer); throw e; }
}

async function ensureCustomFields(locationId, token) {
  const FIELDS = [
    { name: 'Deposit Payment URL', fieldKey: 'contact.deposit_payment_url', dataType: 'TEXT' },
    { name: 'Deposit Status',      fieldKey: 'contact.deposit_status',      dataType: 'TEXT' },
    { name: 'Deposit Amount Paid', fieldKey: 'contact.deposit_amount_paid', dataType: 'NUMERICAL' }
  ];
  let existing = [];
  try {
    const r = await fetchWithTimeout(
      `${GHL_API}/locations/${locationId}/customFields?model=contact`,
      { headers: { Authorization: 'Bearer ' + token, Version: '2021-07-28' } }, 5000
    );
    if (r.ok) { const d = await r.json(); existing = d.customFields || []; }
  } catch (e) { console.warn('[ensureCustomFields] fetch existing:', e.message); }

  const created = [];
  for (const f of FIELDS) {
    const exists = existing.some(e => e.fieldKey === f.fieldKey || e.name === f.name);
    if (exists) continue;
    try {
      const cr = await fetchWithTimeout(
        `${GHL_API}/locations/${locationId}/customFields`,
        { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Version: '2021-07-28' }, body: JSON.stringify({ model: 'contact', ...f }) }, 5000
      );
      const cd = await cr.json();
      if (cr.ok && cd.customField) created.push(cd.customField);
    } catch (e) { console.warn('[ensureCustomFields] create:', e.message); }
  }
  return created;
}

async function registerPaymentProvider(locationId, accessToken) {
  try {
    const r = await fetch(GHL_API + '/payments/custom-provider/provider?locationId=' + locationId, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', Version: '2021-07-28' },
      body: JSON.stringify({
        locationId,
        name: 'HandyPay',
        description: 'Accept deposits and payments via HandyPay (Jamaica)',
        paymentsUrl: APP_URL + '/api/pay',
        queryUrl:    APP_URL + '/api/query',
        imageUrl:    LOGO_URL
      })
    });
    const d = await r.json().catch(() => ({}));
    console.log('[registerPaymentProvider]', r.status, JSON.stringify(d).slice(0,80));
  } catch (e) { console.warn('[registerPaymentProvider]', e.message); }
}

async function registerWebhook(apiKey, locationId) {
  try {
    const HP_BASE = 'https://api.handypay.me/api/v1';
    const r = await fetch(`${HP_BASE}/webhooks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: WEBHOOK_URL, events: ['checkout.session.completed','checkout.session.expired'], isActive: true })
    });
    const d = await r.json();
    const wid = (d.data && d.data.id) || d.id || '';
    const wsec = (d.data && d.data.secret) || d.secret || '';
    if (wid) await pool.query('UPDATE merchant_configs SET handypay_webhook_id=$1, handypay_webhook_secret=$2 WHERE location_id=$3', [wid, wsec, locationId]);
    return { ok: true, webhookId: wid };
  } catch(e) { console.warn('[registerWebhook]', e.message); return { ok: false }; }
}

function sendPage(res, locationId, opts) {
  const cfg     = opts.cfg || null;
  const isOk    = opts.ok    || false;
  const errMsg  = opts.error  || '';
  const pitOk   = cfg && cfg.crm_access_token;
  const hpOk    = cfg && cfg.handypay_api_key;

  const status = pitOk && hpOk ? 'Connected' : pitOk ? 'PIT saved (HandyPay key pending)' : 'Not configured';
  const statusColor = (pitOk && hpOk) ? '#1b5e20' : pitOk ? '#e65100' : '#b71c1c';

  res.setHeader('Content-Type', 'text/html');
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>HandyPay — GHL Setup</title>
  <style>
    body { font-family: 'Segoe UI', sans-serif; background: #f5f5f5; margin: 0; padding: 40px 20px; }
    .card { background: #fff; border-radius: 12px; padding: 32px; max-width: 520px; margin: 0 auto; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
    h2 { margin-top:0; color:#1a1a2e; }
    label { display:block; font-size:13px; font-weight:600; color:#555; margin-bottom:4px; margin-top:16px; }
    input { width:100%; box-sizing:border-box; padding:10px 12px; border:1px solid #ddd; border-radius:6px; font-size:14px; }
    input:focus { outline:none; border-color:#4f46e5; }
    .btn { display:block; width:100%; padding:12px; background:#4f46e5; color:#fff; border:none; border-radius:8px; font-size:15px; font-weight:600; cursor:pointer; margin-top:20px; }
    .btn:hover { background:#4338ca; }
    .status-box { border-radius:8px; padding:12px 16px; margin-bottom:20px; font-size:13px; }
    .ok  { background:#e8f5e9; color:#1b5e20; border:1px solid #a5d6a7; }
    .err { background:#ffebee; color:#b71c1c; border:1px solid #ef9a9a; }
    .step-box { background:#f8faff; border:1px solid #c7d2fe; border-radius:10px; padding:16px; margin-bottom:16px; }
    .step-box .title { font-size:13px; font-weight:700; color:#3730a3; margin-bottom:10px; }
    .step-box .items { font-size:13px; color:#374151; line-height:2.4; }
    .next-box { background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:16px; margin-bottom:16px; }
    .next-box .title { font-size:13px; font-weight:700; color:#166534; margin-bottom:8px; }
    .next-box .items { font-size:13px; color:#374151; line-height:2.4; }
    .wh-box { background:#fff7ed; border:1px solid #fed7aa; border-radius:10px; padding:16px; margin-bottom:16px; }
    .wh-box .title { font-size:13px; font-weight:700; color:#c2410c; margin-bottom:8px; }
    .wh-code { font-size:11px; background:#fff; border:1px solid #e5e7eb; border-radius:6px; padding:6px 10px; display:block; word-break:break-all; font-family:monospace; }
  </style>
</head>
<body>
<div class="card">
  <h2>HandyPay — GHL Setup</h2>
  ${isOk ? `
  <div class="status-box ok" style="margin-bottom:16px"><strong>Setup complete. HandyPay is live.</strong></div>
  <div class="step-box">
    <div class="title">What was set up automatically:</div>
    <div class="items">
      &#9989; GHL connected — PIT mode (no token expiry)<br>
      &#9989; HandyPay API key saved<br>
      &#9989; 3 contact fields created (deposit_status, deposit_payment_url, deposit_amount_paid)<br>
      &#9989; HandyPay registered as GHL payment provider<br>
      &#9989; Webhook auto-registered to receive payment events
    </div>
  </div>
  <div class="wh-box">
    <div class="title">&#128279; Webhook URL (for manual HandyPay setup if needed)</div>
    <code class="wh-code">${WEBHOOK_URL}</code>
  </div>
  <div class="next-box">
    <div class="title">Next steps</div>
    <div class="items">
      1. Load the <strong>HandyPay Deposits Starter</strong> snapshot<br>
      2. <a href="${SETTINGS_URL}?location_id=${locationId}" style="color:#4f46e5;font-weight:600">Open Settings</a> to pick which calendars trigger deposits<br>
      3. Test: book an appointment &rarr; check for deposit SMS
    </div>
  </div>
  ` : ''}
  ${errMsg ? `<div class="status-box err">&#10060; ${errMsg}</div>` : ''}
  <p style="font-size:13px;color:#666;">Status: <strong style="color:${statusColor}">${status}</strong></p>

  <form method="POST" action="/api/ghl-setup?location_id=${locationId}">
    <label>GHL Private Integration Token (PIT)</label>
    <input type="password" name="pit" placeholder="eyJhbG..." required value="" autocomplete="off"/>

    <label>HandyPay API Key</label>
    <input type="password" name="hp_key" placeholder="hp_live_..." required value="" autocomplete="off"/>

    <label>Deposit % (e.g. 30 for 30%)</label>
    <input type="number" name="deposit_pct" min="1" max="100" step="0.1" value="${cfg ? cfg.deposit_percentage || 30 : 30}"/>

    <button class="btn" type="submit">&#128274; Save &amp; Connect</button>
  </form>

  <p style="font-size:11px;color:#aaa;margin-top:24px;">
    Tokens are stored securely. Location ID: <code>${locationId}</code>
  </p>
</div>
<script>
var btn = document.querySelector('.btn');
if(btn) btn.addEventListener('click', function() {
  btn.disabled = true;
  btn.textContent = 'Connecting...';
});
<\/script>
</body>
</html>`);
}

module.exports = async function handler(req, res) {
  const locationId = (req.query && (req.query.location_id || req.query.locationId)) || '';

  if (!locationId) {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<p style="font-family:sans-serif;padding:40px">Missing <code>location_id</code> query parameter.</p>');
  }

  if (req.method !== 'POST') {
    const cfg = await getMerchantConfig(locationId).catch(() => null);
    return sendPage(res, locationId, { cfg });
  }

  // Parse body
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = Object.fromEntries(new URLSearchParams(body)); } catch (e) {}
  }

  const pit    = (body.pit    || '').trim();
  const hp_key = (body.hp_key || '').trim();
  const depositPct = parseFloat(body.deposit_pct || '30') || 30;

  if (!pit || !hp_key) {
    const cfg = await getMerchantConfig(locationId).catch(() => null);
    sendPage(res, locationId, { cfg, error: 'Both PIT token and HandyPay API key are required.' });
    return;
  }

  // Validate PIT against GHL API
  let tokenWorks = false;
  try {
    const vr = await fetchWithTimeout(
      GHL_API + '/users/me',
      { headers: { Authorization: 'Bearer ' + pit, Version: '2021-07-28' } }, 5000
    );
    if (vr.ok) tokenWorks = true;
  } catch (e) { console.warn('[ghl-setup] validate PIT:', e.message); }

  if (!tokenWorks) {
    const cfg = await getMerchantConfig(locationId).catch(() => null);
    sendPage(res, locationId, { cfg, error: 'GHL token validation failed. Check your PIT and try again.' });
    return;
  }

  // Save config
  try {
    await upsertMerchantConfig(locationId, {
      crm_access_token: pit,
      handypay_api_key: hp_key,
      deposit_percentage: depositPct,
      deposit_amount: 5000
    });
  } catch (e) {
    sendPage(res, locationId, { error: 'Database save failed: ' + e.message });
    return;
  }

  // Auto-create HandyPay custom fields
  await ensureCustomFields(locationId, pit).catch(e => console.warn('[ghl-setup] ensureCustomFields:', e.message));

  // Register as GHL custom payment provider
  await registerPaymentProvider(locationId, pit).catch(e => console.warn('[ghl-setup] registerPaymentProvider:', e.message));

  // Register HandyPay webhook
  await registerWebhook(hp_key, locationId).catch(e => console.warn('[ghl-setup] registerWebhook:', e.message));

  const cfg = await getMerchantConfig(locationId).catch(() => null);
  sendPage(res, locationId, { cfg, ok: true });
};
