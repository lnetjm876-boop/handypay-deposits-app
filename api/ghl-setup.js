// api/ghl-setup.js — One-time GHL connection page (PIT mode)
// Sub-account pastes their GHL Private Integration Token → stored permanently
// No OAuth, no token expiry, no re-auth ever needed
'use strict';
const { Pool } = require('pg');

const GHL_API = 'https://services.leadconnectorhq.com';
const APP_URL = process.env.APP_URL || 'https://handypay-deposits-app.vercel.app';
const LOGO_URL = 'https://storage.googleapis.com/crm-conversations-ai-production/ask-ai-images/1785549533996/aaf88bbe-7f89-44b6-ba1b-12a6417755f6.png';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function getMerchantConfig(locationId) {
  const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [locationId]);
  return rows[0] || null;
}

async function parseFormBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const obj = {};
        for (const [key, value] of params.entries()) obj[key] = value;
        resolve(obj);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
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
        imageUrl: LOGO_URL,
        supportsSubscriptionSchedule: false
      })
    });
    const d = await r.json();
    console.log('[ghl-setup] register provider', locationId, r.status, JSON.stringify(d).substring(0, 100));
    return { status: r.status, data: d };
  } catch (e) {
    console.error('[ghl-setup] register err:', e.message);
    return { error: e.message };
  }
}

module.exports = async function handler(req, res) {
  const locationId = ((req.query && req.query.location_id) || '').trim();

  if (!locationId) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send('<div style="font-family:sans-serif;padding:40px;color:#c62828">Missing <code>location_id</code> query parameter.<br><br>URL should be: <code>/api/ghl-setup?location_id=YOUR_LOCATION_ID</code></div>');
  }

  // ── GET: show the form ───────────────────────────────────────
  if (req.method === 'GET') {
    const cfg = await getMerchantConfig(locationId).catch(() => null);
    const hasHandypay = cfg && cfg.handypay_api_key;
    const isPitMode = cfg && cfg.crm_access_token && !cfg.crm_refresh_token;
    const isOauthMode = cfg && cfg.crm_access_token && cfg.crm_refresh_token;
    const maskedPit = isPitMode ? cfg.crm_access_token.substring(0, 20) + '...' : '';
    const savedMsg = req.query.saved ? 'GHL API Key saved! You are now in permanent auth mode — no OAuth or re-auth ever needed.' : '';
    const errMsg = req.query.error ? decodeURIComponent(req.query.error) : '';

    let statusBlock = '';
    if (!hasHandypay) {
      statusBlock = '<div class="warn">⚠️ Complete HandyPay settings first — enter your HandyPay API key in the <strong>HandyPay Settings</strong> sidebar menu before setting up GHL connection.</div>';
    } else if (isPitMode) {
      statusBlock = '<div class="badge"><span class="dot"></span> GHL Connected (permanent PIT mode) &middot; <code>' + maskedPit + '</code></div>';
    } else if (isOauthMode) {
      statusBlock = '<div class="badge oauth"><span class="dot" style="background:#f57c00"></span> GHL Connected (OAuth mode) &middot; Upgrade to permanent PIT below</div>';
    } else {
      statusBlock = '<div class="warn">⚠️ GHL not connected — paste your API key below</div>';
    }

    res.setHeader('Content-Type', 'text/html');
    return res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HandyPay — GHL Connection</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f6fb;padding:24px;min-height:100vh}
.card{background:#fff;border-radius:16px;box-shadow:0 4px 32px rgba(0,0,0,.1);max-width:600px;margin:0 auto;padding:40px}
.hdr{margin-bottom:24px;padding-bottom:20px;border-bottom:2px solid #f0f0f0}
.hdr h1{font-size:22px;font-weight:800;color:#005DBD;margin-bottom:4px}
.hdr p{font-size:13px;color:#888}
.ok{background:#e8f5e9;border:1px solid #a5d6a7;color:#2e7d32;padding:14px 16px;border-radius:10px;font-size:14px;margin-bottom:18px;line-height:1.5}
.err{background:#fce4ec;border:1px solid #f48fb1;color:#c62828;padding:14px 16px;border-radius:10px;font-size:14px;margin-bottom:18px}
.warn{background:#fff8e1;border:1px solid #ffe082;color:#e65100;padding:14px 16px;border-radius:10px;font-size:13px;margin-bottom:18px;line-height:1.6}
.badge{background:#e3f2fd;color:#1565c0;padding:10px 16px;border-radius:10px;font-size:13px;margin-bottom:18px;display:flex;align-items:center;gap:8px}
.badge.oauth{background:#fff3e0;color:#e65100}
.dot{width:8px;height:8px;border-radius:50%;background:#43a047;flex-shrink:0}
.steps{background:#f8f9ff;border:1px solid #dde8ff;border-radius:12px;padding:20px;margin:20px 0;line-height:2.2}
.steps h3{font-size:14px;font-weight:700;color:#005DBD;margin-bottom:8px}
.step{display:flex;gap:12px;align-items:flex-start;font-size:13px;color:#444}
.step-num{background:#005DBD;color:#fff;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;margin-top:2px}
.step-txt code{background:#e8f0fe;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600}
label{display:block;font-size:13px;font-weight:700;color:#333;margin-top:20px;margin-bottom:6px}
input{width:100%;border:2px solid #e0e0e0;border-radius:10px;padding:12px 16px;font-size:14px;font-family:monospace;outline:none;transition:border-color .2s}
input:focus{border-color:#005DBD;box-shadow:0 0 0 3px rgba(0,93,189,.1)}
.btn{width:100%;margin-top:24px;background:#005DBD;color:#fff;border:none;border-radius:10px;padding:15px;font-size:16px;font-weight:700;cursor:pointer;transition:background .2s}
.btn:hover{background:#0047a3}
.foot{margin-top:20px;text-align:center;font-size:11px;color:#ccc}
.pill{display:inline-block;background:#005DBD;color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:99px;margin-left:6px;vertical-align:middle}
</style></head>
<body><div class="card">
<div class="hdr">
  <h1>&#128273; GHL Connection <span class="pill">PERMANENT</span></h1>
  <p>Enter once — never authenticate again</p>
</div>
${savedMsg ? `<div class="ok">&#9989; ${savedMsg}</div>` : ''}
${errMsg ? `<div class="err">&#10060; ${errMsg}</div>` : ''}
${statusBlock}
<div class="steps">
  <h3>How to find your GHL Private Integration Token</h3>
  <div class="step"><div class="step-num">1</div><div class="step-txt">In your CRM sub-account, click the <strong>gear icon</strong> (Settings) in the bottom-left sidebar</div></div>
  <div class="step"><div class="step-num">2</div><div class="step-txt">Go to <strong>Integrations</strong> &rarr; then the <strong>API Key</strong> tab</div></div>
  <div class="step"><div class="step-num">3</div><div class="step-txt">Copy your API key — it starts with <code>pit-</code></div></div>
  <div class="step"><div class="step-num">4</div><div class="step-txt">Paste it below and click Save</div></div>
</div>
<form method="POST" action="/api/ghl-setup?location_id=${encodeURIComponent(locationId)}">
  <label>GHL Private Integration Token *</label>
  <input type="text" name="ghl_api_key" placeholder="pit-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" required autocomplete="off" spellcheck="false">
  <button class="btn" type="submit">&#128190; Save &amp; Connect Forever</button>
</form>
<div class="foot">HandyPay Deposits &middot; Permanent Auth Mode &middot; Location: ${locationId}</div>
</div></body></html>`);
  }

  // ── POST: save the GHL API key ───────────────────────────────
  if (req.method === 'POST') {
    let body = {};
    try { body = await parseFormBody(req); } catch (e) {}

    const ghlApiKey = ((body.ghl_api_key || req.query.ghl_api_key) || '').trim();

    if (!ghlApiKey) {
      return res.redirect('/api/ghl-setup?location_id=' + encodeURIComponent(locationId) + '&error=' + encodeURIComponent('GHL API Key is required'));
    }
    if (!ghlApiKey.startsWith('pit-') && !ghlApiKey.startsWith('eyJ')) {
      return res.redirect('/api/ghl-setup?location_id=' + encodeURIComponent(locationId) + '&error=' + encodeURIComponent('Invalid key format. The key should start with pit-'));
    }

    try {
      // Check if location exists in merchant_configs
      const cfg = await getMerchantConfig(locationId);
      if (!cfg) {
        return res.redirect('/api/ghl-setup?location_id=' + encodeURIComponent(locationId) + '&error=' + encodeURIComponent('Location not set up yet. Complete HandyPay Settings first.'));
      }

      // Store PIT as crm_access_token, clear refresh_token (PIT mode = permanent)
      await pool.query(
        'UPDATE merchant_configs SET crm_access_token=$1, crm_refresh_token=NULL, ghl_access_token=$1, ghl_refresh_token=NULL, updated_at=NOW() WHERE location_id=$2',
        [ghlApiKey, locationId]
      );

      // Try to register/re-register the payment provider with the new token
      await registerPaymentProvider(locationId, ghlApiKey);

      return res.redirect('/api/ghl-setup?location_id=' + encodeURIComponent(locationId) + '&saved=true');
    } catch (e) {
      console.error('[ghl-setup] POST error:', e.message);
      return res.redirect('/api/ghl-setup?location_id=' + encodeURIComponent(locationId) + '&error=' + encodeURIComponent(e.message));
    }
  }

  return res.status(405).send('Method Not Allowed');
};
