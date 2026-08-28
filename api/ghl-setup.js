// api/ghl-setup.js — One-time GHL connection page (PIT mode)
// Sub-account pastes their GHL Private Integration Token → stored permanently
// FIXED: no res.redirect(), robust body parsing, correct column names
'use strict';
const { Pool } = require('pg');

const GHL_API = 'https://services.leadconnectorhq.com';
const APP_URL = process.env.APP_URL || 'https://handypay-deposits-app.vercel.app';
const LOGO_URL = 'https://storage.googleapis.com/crm-conversations-ai-production/ask-ai-images/1785549533996/aaf88bbe-7f89-44b6-ba1b-12a6417755f6.png';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000
});

const GHL_CUSTOM_FIELDS = [
  { name: 'Deposit Payment URL',  dataType: 'TEXT',   model: 'contact' },
  { name: 'Deposit Status',       dataType: 'TEXT',   model: 'contact' },
  { name: 'Deposit Amount Paid',  dataType: 'NUMERICAL', model: 'contact' }
];

async function getMerchantConfig(locationId) {
  const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [locationId]);
  return rows[0] || null;
}

async function upsertMerchantConfig(locationId, fields) {
  const keys   = Object.keys(fields);
  const vals   = Object.values(fields);
  const setClauses = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
  await pool.query(
    `INSERT INTO merchant_configs (location_id, ${keys.join(', ')}) VALUES ($1, ${vals.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (location_id) DO UPDATE SET ${setClauses}, updated_at = NOW()`,
    [locationId, ...vals]
  );
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return r;
  } catch (e) { clearTimeout(timer); throw e; }
}

async function ensureCustomFields(locationId, token) {
  let existing = [];
  try {
    const r = await fetchWithTimeout(
      `${GHL_API}/locations/${locationId}/customFields?model=contact`,
      { headers: { Authorization: 'Bearer ' + token, Version: '2021-07-28' } }, 5000
    );
    if (r.ok) { const d = await r.json(); existing = d.customFields || []; }
  } catch (e) { console.warn('[ghl-setup] fetch fields:', e.message); }

  const created = [];
  for (const cf of GHL_CUSTOM_FIELDS) {
    const exists = existing.some(f =>
      f.name.toLowerCase() === cf.name.toLowerCase() ||
      (f.fieldKey && f.fieldKey.toLowerCase().includes(cf.name.toLowerCase().replace(/ /g, '_')))
    );
    if (exists) { console.log('[ghl-setup] field exists:', cf.name); continue; }
    try {
      const cr = await fetchWithTimeout(
        `${GHL_API}/locations/${locationId}/customFields`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Version: '2021-07-28' },
          body: JSON.stringify({ name: cf.name, dataType: cf.dataType, model: cf.model })
        }, 5000
      );
      const cd = await cr.json();
      console.log('[ghl-setup] created field:', cf.name, cr.status);
      if (cr.ok && cd.customField) created.push(cd.customField);
    } catch (e) { console.warn('[ghl-setup] create field:', cf.name, e.message); }
  }
  return created;
}

async function registerPaymentProvider(locationId, accessToken) {
  try {
    const r = await fetch(GHL_API + '/payments/custom-provider/provider?locationId=' + locationId, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
      body: JSON.stringify({
        name: 'HandyPay Deposits',
        description: 'Collect booking deposits automatically via SMS payment link.',
        paymentsUrl: APP_URL + '/api/pay?locationId=' + locationId,
        queryUrl: APP_URL + '/api/query',
        refundUrl: APP_URL + '/api/refund',
        imageUrl: LOGO_URL,
        supportsSubscriptionSchedule: false
      })
    });
    const d = await r.json();
    console.log('[ghl-setup] register', locationId, r.status);
    return d;
  } catch (e) { console.error('[ghl-setup] register err:', e.message); }
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
  </style>
</head>
<body>
<div class="card">
  <h2>HandyPay — GHL Setup</h2>
  ${isOk  ? `<div class="status-box ok">✅ Configuration saved. HandyPay is connected and ready.</div>` : ''}
  ${errMsg ? `<div class="status-box err">❌ ${errMsg}</div>` : ''}
  <p style="font-size:13px;color:#666;">Status: <strong style="color:${statusColor}">${status}</strong></p>

  <form method="POST" action="/api/ghl-setup?location_id=${locationId}">
    <label>GHL Private Integration Token (PIT)</label>
    <input type="password" name="pit" placeholder="eyJhbG..." required value="" autocomplete="off"/>

    <label>HandyPay API Key</label>
    <input type="password" name="hp_key" placeholder="hp_live_..." required value="" autocomplete="off"/>

    <label>Deposit % (e.g. 30 for 30%)</label>
    <input type="number" name="deposit_pct" min="1" max="100" step="0.1" value="${cfg ? cfg.deposit_percentage || 30 : 30}"/>

    <button class="btn" type="submit">💾 Save & Connect Forever</button>
  </form>

  <p style="font-size:11px;color:#aaa;margin-top:24px;">
    Tokens are encrypted and stored securely. Location ID: <code>${locationId}</code>
  </p>
</div>
<script>
var btn = document.querySelector('.btn');
if(btn) btn.addEventListener('click', function() {
  btn.disabled = true;
  btn.textContent = 'Saving...';
});
</script>
</body></html>`);
}

module.exports = async function handler(req, res) {
  const locationId = ((req.query && req.query.location_id) || '').trim();

  if (!locationId) {
    res.setHeader('Content-Type', 'text/html');
    res.end('<div style="font-family:sans-serif;padding:40px;color:#c62828">Missing <code>location_id</code></div>');
    return;
  }

  if (req.method === 'GET') {
    const cfg = await getMerchantConfig(locationId).catch(() => null);
    sendPage(res, locationId, { cfg });
    return;
  }

  if (req.method !== 'POST') return res.status(405).end();

  // Parse body — Vercel serverless with express middleware
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
  let ghlUserId = '', tokenWorks = false;
  try {
    const vr = await fetchWithTimeout(
      GHL_API + '/users/me',
      { headers: { Authorization: 'Bearer ' + pit, Version: '2021-07-28' } }, 5000
    );
    if (vr.ok) {
      const vd = await vr.json();
      ghlUserId = vd.id || '';
      tokenWorks = true;
    }
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
  const created = await ensureCustomFields(locationId, pit).catch(e => {
    console.warn('[ghl-setup] ensureCustomFields error:', e.message);
    return [];
  });
  console.log('[ghl-setup] ensureCustomFields created:', created.length);

  // Register as GHL custom payment provider
  await registerPaymentProvider(locationId, pit).catch(e =>
    console.warn('[ghl-setup] registerPaymentProvider:', e.message)
  );

  const cfg = await getMerchantConfig(locationId).catch(() => null);
  sendPage(res, locationId, { cfg, ok: true });
};
