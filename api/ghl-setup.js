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
  ssl: { rejectUnauthorized: false }
});

async function getMerchantConfig(locationId) {
  const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [locationId]);
  return rows[0] || null;
}

// Robust body parser — handles Vercel pre-buffered body (object, string, Buffer) + stream fallback
async function parseBody(req) {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  if (typeof b === 'string') { const p = new URLSearchParams(b); const o = {}; for (const [k,v] of p) o[k]=v; return o; }
  if (Buffer.isBuffer(b)) { const p = new URLSearchParams(b.toString()); const o = {}; for (const [k,v] of p) o[k]=v; return o; }
  return new Promise((resolve) => {
    let data = ''; let done = false;
    const finish = (raw) => { if (done) return; done = true; try { const p = new URLSearchParams(raw); const o = {}; for (const [k,v] of p) o[k]=v; resolve(o); } catch (e) { resolve({}); } };
    req.on('data', (chunk) => { data += chunk.toString(); });
    req.on('end', () => finish(data));
    req.on('error', () => finish(data));
    setTimeout(() => finish(data), 5000);
  });
}

function sendPage(res, locationId, opts) {
  const { savedMsg, errMsg, cfg } = opts || {};
  const hasHandypay = cfg && cfg.handypay_api_key;
  const isPitMode   = cfg && cfg.crm_access_token && !cfg.crm_refresh_token;
  const isOauthMode = cfg && cfg.crm_access_token && cfg.crm_refresh_token;
  const maskedPit   = isPitMode ? cfg.crm_access_token.substring(0, 20) + '...' : '';

  let statusBlock = '';
  if (!hasHandypay) {
    statusBlock = '<div class="warn">⚠️ Complete HandyPay settings first — enter your HandyPay API key in the sidebar before connecting GHL.</div>';
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
.ok{background:#e8f5e9;border:1px solid #a5d6a7;color:#2e7d32;padding:14px 16px;border-radius:10px;font-size:14px;margin-bottom:18px;line-height:1.5;display:none}
.err-box{background:#fce4ec;border:1px solid #f48fb1;color:#c62828;padding:14px 16px;border-radius:10px;font-size:14px;margin-bottom:18px;display:none}
.warn{background:#fff8e1;border:1px solid #ffe082;color:#e65100;padding:14px 16px;border-radius:10px;font-size:13px;margin-bottom:18px;line-height:1.6}
.badge{background:#e3f2fd;color:#1565c0;padding:10px 16px;border-radius:10px;font-size:13px;margin-bottom:18px;display:flex;align-items:center;gap:8px}
.badge.oauth{background:#fff3e0;color:#e65100}
.dot{width:8px;height:8px;border-radius:50%;background:#43a047;flex-shrink:0}
.steps{background:#f8f9ff;border:1px solid #dde8ff;border-radius:12px;padding:20px;margin:20px 0;line-height:2.2}
.steps h3{font-size:14px;font-weight:700;color:#005DBD;margin-bottom:8px}
.step{display:flex;gap:12px;align-items:flex-start;font-size:13px;color:#444;margin-bottom:4px}
.step-num{background:#005DBD;color:#fff;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;margin-top:2px}
.step-txt code{background:#e8f0fe;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600}
label{display:block;font-size:13px;font-weight:700;color:#333;margin-top:20px;margin-bottom:6px}
input{width:100%;border:2px solid #e0e0e0;border-radius:10px;padding:12px 16px;font-size:14px;font-family:monospace;outline:none;transition:border-color .2s}
input:focus{border-color:#005DBD;box-shadow:0 0 0 3px rgba(0,93,189,.1)}
.btn{width:100%;margin-top:24px;background:#005DBD;color:#fff;border:none;border-radius:10px;padding:15px;font-size:16px;font-weight:700;cursor:pointer;transition:background .2s}
.btn:hover{background:#0047a3}.btn:disabled{background:#aaa;cursor:not-allowed}
.foot{margin-top:20px;text-align:center;font-size:11px;color:#ccc}
.pill{display:inline-block;background:#005DBD;color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:99px;margin-left:6px;vertical-align:middle}
</style></head>
<body><div class="card">
<div class="hdr">
  <h1>&#128273; GHL Connection <span class="pill">PERMANENT</span></h1>
  <p>Enter once — never authenticate again</p>
</div>
<div class="ok" id="ok-msg"></div>
<div class="err-box" id="err-msg"></div>
${statusBlock}
<div class="steps">
  <h3>How to find your GHL Private Integration Token</h3>
  <div class="step"><div class="step-num">1</div><div class="step-txt">In your CRM sub-account, click the <strong>gear icon</strong> (Settings) in the bottom-left sidebar</div></div>
  <div class="step"><div class="step-num">2</div><div class="step-txt">Go to <strong>Integrations</strong> &rarr; then the <strong>API Key</strong> tab</div></div>
  <div class="step"><div class="step-num">3</div><div class="step-txt">Copy your API key — it starts with <code>pit-</code></div></div>
  <div class="step"><div class="step-num">4</div><div class="step-txt">Paste it below and click Save</div></div>
</div>
${!isPitMode ? `<div id="form-section">
  <label for="ghl-key">GHL Private Integration Token *</label>
  <input type="text" id="ghl-key" placeholder="pit-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off" spellcheck="false">
  <button class="btn" id="save-btn" onclick="saveKey()">&#128190; Save &amp; Connect Forever</button>
</div>` : '<p style="text-align:center;color:#2e7d32;font-size:15px;font-weight:700;margin-top:16px">&#9989; Already on permanent PIT mode. Done.</p>'}
<div class="foot">HandyPay Deposits &middot; Permanent Auth Mode &middot; ${locationId}</div>
</div>
<script>
var LOC="${locationId}";
async function saveKey(){
  var key=document.getElementById('ghl-key').value.trim();
  var btn=document.getElementById('save-btn');
  var okEl=document.getElementById('ok-msg');
  var errEl=document.getElementById('err-msg');
  okEl.style.display='none';errEl.style.display='none';
  if(!key){errEl.textContent='Please enter your GHL API key.';errEl.style.display='block';return;}
  btn.disabled=true;btn.textContent='Saving...';
  try{
    var r=await fetch('/api/ghl-setup?location_id='+encodeURIComponent(LOC),{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ghl_api_key:key})
    });
    var data=await r.json();
    if(data.success){
      okEl.textContent='\u2705 '+data.message;
      okEl.style.display='block';
      document.getElementById('form-section').style.display='none';
    }else{
      errEl.textContent='\u274C '+(data.error||'Unknown error');
      errEl.style.display='block';
    }
  }catch(e){
    errEl.textContent='\u274C Network error: '+e.message;
    errEl.style.display='block';
  }
  btn.disabled=false;btn.textContent='\uD83D\uDCBE Save & Connect Forever';
}
</script>
</body></html>`);
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
    res.end('<div style="font-family:sans-serif;padding:40px;color:#c62828">Missing <code>location_id</code></div>');
    return;
  }

  if (req.method === 'GET') {
    const cfg = await getMerchantConfig(locationId).catch(() => null);
    sendPage(res, locationId, { cfg });
    return;
  }

  if (req.method === 'POST') {
    let body = {};
    try { body = await parseBody(req); } catch (e) { console.error('[ghl-setup] parseBody err:', e.message); }

    const ghlApiKey = (body.ghl_api_key || '').trim();
    console.log('[ghl-setup] POST loc=' + locationId + ' keyLen=' + ghlApiKey.length + ' prefix=' + ghlApiKey.substring(0, 8));

    if (!ghlApiKey) {
      const cfg = await getMerchantConfig(locationId).catch(() => null);
      sendPage(res, locationId, { cfg, errMsg: 'GHL API Key is required — paste your pit- key above.' });
      return;
    }
    if (!ghlApiKey.startsWith('pit-') && !ghlApiKey.startsWith('eyJ')) {
      const cfg = await getMerchantConfig(locationId).catch(() => null);
      sendPage(res, locationId, { cfg, errMsg: 'Invalid key — should start with pit- (got: ' + ghlApiKey.substring(0, 8) + '...)' });
      return;
    }

    try {
      const cfg = await getMerchantConfig(locationId);
      if (!cfg) {
        sendPage(res, locationId, { errMsg: 'Location not found — complete HandyPay Settings first.' });
        return;
      }

      // Store PIT, NULL out refresh_token → permanent mode (only crm_ columns exist)
      await pool.query(
        'UPDATE merchant_configs SET crm_access_token=$1, crm_refresh_token=NULL, updated_at=NOW() WHERE location_id=$2',
        [ghlApiKey, locationId]
      );
      console.log('[ghl-setup] PIT stored for', locationId);

      await registerPaymentProvider(locationId, ghlApiKey);

      const updatedCfg = await getMerchantConfig(locationId).catch(() => null);
      return res.json ? res.json({ success: true, message: 'GHL API Key saved. Permanent PIT mode active — no OAuth or re-auth ever needed.' })
                      : (res.setHeader('Content-Type','application/json'), res.end(JSON.stringify({ success: true, message: 'GHL API Key saved. Permanent PIT mode active — no OAuth or re-auth ever needed.' })));
    } catch (e) {
      console.error('[ghl-setup] POST error:', e.message);
      return res.json ? res.json({ success: false, error: e.message })
                      : (res.setHeader('Content-Type','application/json'), res.end(JSON.stringify({ success: false, error: e.message })));
    }
  }

  res.statusCode = 405;
  res.end('Method Not Allowed');
};
