// api/ghl-setup.js — One-time GHL connection page (PIT mode)
// Sub-account pastes their GHL Private Integration Token → stored permanently
// FIXED: no res.redirect() (causes loops in Vercel serverless)
//        body parsed from req.body (Vercel buffers it) with stream fallback
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

// Robust body parser — handles Vercel pre-buffered body (object, string, Buffer) + stream fallback
async function parseBody(req) {
  const b = req.body;
  // Already parsed as plain object
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  // String body (URL-encoded)
  if (typeof b === 'string') {
    const p = new URLSearchParams(b); const o = {};
    for (const [k, v] of p) o[k] = v; return o;
  }
  // Buffer body
  if (Buffer.isBuffer(b)) {
    const p = new URLSearchParams(b.toString()); const o = {};
    for (const [k, v] of p) o[k] = v; return o;
  }
  // Stream fallback with 5s timeout
  return new Promise((resolve) => {
    let data = ''; let done = false;
    const finish = (raw) => { if (done) return; done = true; try { const p = new URLSearchParams(raw); const o = {}; for (const [k, v] of p) o[k] = v; resolve(o); } catch (e) { resolve({}); } };
    req.on('data', (chunk) => { data += chunk.toString(); });
    req.on('end', () => finish(data));
    req.on('error', () => finish(data));
    setTimeout(() => finish(data), 5000);
  });
}

// Render page HTML directly — works for GET and POST (zero redirects)
function sendPage(res, locationId, opts) {
  const { savedMsg, errMsg, cfg } = opts || {};
  const hasHandypay = cfg && cfg.handypay_api_key;
  const isPitMode   = cfg && cfg.crm_access_token && !cfg.crm_refresh_token;
  const isOauthMode = cfg && cfg.crm_access_token && cfg.crm_refresh_token;
  const maskedPit   = isPitMode ? cfg.crm_access_token.substring(0, 20) + '...' : '';

  let statusBlock = '';
  if (!hasHandypay) {
    statusBlock = '<div class="warn">⚠️ Complete HandyPay settings first — enter your HandyPay API key in the <strong>HandyPay Settings</strong> sidebar menu before connecting GHL.</div>';
  } else if (isPitMode) {
    statusBlock = '<div class="badge"><span class="dot"></span> GHL Connected (permanent PIT mode) &middot; <code>' + maskedPit + '</code></div>';
  } else if (isOauthMode) {
    statusBlock = '<div class="badge oauth"><span class="dot" style="background:#f57c00"></span> GHL Connected (OAuth mode) &middot; Upgrade to permanent PIT below</div>';
  } else {
    statusBlock = '<div class="warn">⚠️ GHL not connected — paste your API key below</div>';
  }

  res.setHeader('Content-Type', 'text/html');
  res.end(`<!DOCTYPE html>
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
${errMsg   ? `<div class="err">&#10060; ${errMsg}</div>` : ''}
${statusBlock}
<div class="steps">
  <h3>How to find your GHL Private Integration Token</h3>
  <div class="step"><div class="step-num">1</div><div class="step-txt">In your CRM sub-account, click the <strong>gear icon</strong> (Settings) in the bottom-left sidebar</div></div>
  <div class="step"><div class="step-num">2</div><div class="step-txt">Go to <strong>Integrations</strong> &rarr; then the <strong>API Key</strong> tab</div></div>
  <div class="step"><div class="step-num">3</div><div class="step-txt">Copy your API key — it starts with <code>pit-</code></div></div>
  <div class="step"><div class="step-num">4</div><div class="step-txt">Paste it below and click Save</div></div>
</div>
${!isPitMode ? `
<form method="POST" action="/api/ghl-setup?location_id=${encodeURIComponent(locationId)}">
  <label>GHL Private Integration Token *</label>
  <input type="text" name="ghl_api_key" placeholder="pit-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" required autocomplete="off" spellcheck="false">
  <button class="btn" type="submit">&#128190; Save &amp; Connect Forever</button>
</form>` : '<p style="text-align:center;color:#2e7d32;font-size:14px;margin-top:16px;font-weight:700">&#9989; Already on permanent PIT mode. No further action needed.</p>'}
<div class="foot">HandyPay Deposits &middot; Permanent Auth Mode &middot; Location: ${locationId}</div>
</div></body></html>`);
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
    console.log('[ghl-setup] register', locationId, r.status);
    return d;
  } catch (e) { console.error('[ghl-setup] register err:', e.message); }
}

module.exports = async function handler(req, res) {
  const locationId = ((req.query && req.query.location_id) || '').trim();

  if (!locationId) {
    res.setHeader('Content-Type', 'text/html');
    res.end('<div style="font-family:sans-serif;padding:40px;color:#c62828">Missing <code>location_id</code> — URL should be <code>/api/ghl-setup?location_id=YOUR_LOCATION_ID</code></div>');
    return;
  }

  // ── GET ─────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const cfg = await getMerchantConfig(locationId).catch(() => null);
    sendPage(res, locationId, { cfg });
    return;
  }

  // ── POST ───────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body = {};
    try { body = await parseBody(req); } catch (e) { console.error('[ghl-setup] parseBody err:', e.message); }

    const ghlApiKey = (body.ghl_api_key || '').trim();
    console.log('[ghl-setup] POST locationId=' + locationId + ' keyLen=' + ghlApiKey.length + ' keyPrefix=' + ghlApiKey.substring(0, 8));

    if (!ghlApiKey) {
      const cfg = await getMerchantConfig(locationId).catch(() => null);
      sendPage(res, locationId, { cfg, errMsg: 'GHL API Key is required — please paste your pit- key above.' });
      return;
    }
    if (!ghlApiKey.startsWith('pit-') && !ghlApiKey.startsWith('eyJ')) {
      const cfg = await getMerchantConfig(locationId).catch(() => null);
      sendPage(res, locationId, { cfg, errMsg: 'Invalid key format — key should start with pit- (got: ' + ghlApiKey.substring(0, 8) + '...)' });
      return;
    }

    try {
      const cfg = await getMerchantConfig(locationId);
      if (!cfg) {
        sendPage(res, locationId, { errMsg: 'Location not set up — complete HandyPay Settings first, then come back here.' });
        return;
      }

      // Store PIT, NULL out refresh_token → permanent mode, never expires
      await pool.query(
        'UPDATE merchant_configs SET crm_access_token=$1, crm_refresh_token=NULL, ghl_access_token=$1, ghl_refresh_token=NULL, updated_at=NOW() WHERE location_id=$2',
        [ghlApiKey, locationId]
      );
      console.log('[ghl-setup] PIT stored for', locationId);

      // Re-register payment provider with permanent token
      await registerPaymentProvider(locationId, ghlApiKey);

      // Reload config and show success
      const updatedCfg = await getMerchantConfig(locationId).catch(() => null);
      sendPage(res, locationId, {
        cfg: updatedCfg,
        savedMsg: 'GHL API Key saved! Permanent PIT mode is now active — no OAuth or re-auth ever needed.'
      });
    } catch (e) {
      console.error('[ghl-setup] POST error:', e.message);
      const cfg = await getMerchantConfig(locationId).catch(() => null);
      sendPage(res, locationId, { cfg, errMsg: 'Save failed: ' + e.message });
    }
    return;
  }

  res.statusCode = 405;
  res.end('Method Not Allowed');
};
