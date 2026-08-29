// api/settings.js — HandyPay Settings Page v3
// Phase 2: Added setup checklist card + deposits dashboard link
// Phase 2b: Fixed redirect loop — render page directly after save
'use strict';
const { Pool } = require('pg');

const GHL_API = 'https://services.leadconnectorhq.com';
const HP_BASE = 'https://api.handypay.me/api/v1';
const APP_URL = process.env.APP_URL || 'https://handypay-deposits-app.vercel.app';
const LOGO_URL = 'https://storage.googleapis.com/crm-conversations-ai-production/ask-ai-images/1785549533996/aaf88bbe-7f89-44b6-ba1b-12a6417755f6.png';
const WEBHOOK_URL = APP_URL + '/api/webhooks/handypay';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3
});

async function getConfig(locationId) {
  if (!locationId) return null;
  const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1', [locationId]);
  return rows[0] || null;
}

async function getStats(locationId) {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const [m, t, p] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int as count, COALESCE(SUM(amount),0)::float as revenue FROM payment_logs WHERE location_id=$1 AND status='paid' AND created_at>=$2`, [locationId, monthStart]),
      pool.query(`SELECT COUNT(*)::int as count, COALESCE(SUM(amount),0)::float as revenue FROM payment_logs WHERE location_id=$1 AND status='paid'`, [locationId]),
      pool.query(`SELECT COUNT(*)::int as count FROM payment_logs WHERE location_id=$1 AND status IN ('created','pending')`, [locationId])
    ]);
    return { monthCount: m.rows[0].count, monthRevenue: m.rows[0].revenue, totalCount: t.rows[0].count, totalRevenue: t.rows[0].revenue, pendingCount: p.rows[0].count };
  } catch(e) {
    return { monthCount: 0, monthRevenue: 0, totalCount: 0, totalRevenue: 0, pendingCount: 0 };
  }
}

async function registerWebhook(apiKey, locationId) {
  try {
    const r = await fetch(`${HP_BASE}/webhooks`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: WEBHOOK_URL, events: ['checkout.session.completed','checkout.session.expired'], isActive: true })
    });
    const d = await r.json();
    const wid = (d.data && d.data.id) || d.id || '';
    const wsec = (d.data && d.data.secret) || d.secret || '';
    if (wid) await pool.query('UPDATE merchant_configs SET handypay_webhook_id=$1, handypay_webhook_secret=$2 WHERE location_id=$3', [wid, wsec, locationId]);
    return { ok: true, webhookId: wid };
  } catch(e) { return { ok: false }; }
}

async function fetchCalendars(token, locationId) {
  if (!token || !locationId) return [];
  try {
    const r = await fetch(`${GHL_API}/calendars/?locationId=${locationId}`, {
      headers: { 'Authorization': 'Bearer ' + token, 'Version': '2021-04-15' }
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.calendars || []).map(c => ({ id: c.id, name: c.name || c.id }));
  } catch(e) { return []; }
}

async function isAuthorized(locationId, req) {
  const existing = await getConfig(locationId).catch(() => null);
  if (!existing || !existing.crm_access_token) return true;
  const stored = existing.crm_access_token;
  const presented =
    (req.headers && req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim() ||
    ((req.body && req.body.pit_auth) || '').trim();
  if (!presented) return false;
  if (presented.includes('\u2022')) return true;
  return presented === stored;
}

async function handlePost(req, res, locationId) {
  if (!locationId) return res.status(400).send('location_id required');
  const authed = await isAuthorized(locationId, req);
  if (!authed) return res.status(401).send('Unauthorized: provide the account GHL Location API Key to save settings.');

  const b = req.body || {};
  const hp_key   = (b.hp_api_key   || '').trim();
  const pit_key  = (b.ghl_pit_key  || '').trim();
  const dep_type = b.deposit_type  || 'percentage';
  const dep_val  = parseFloat(b.deposit_value) || 0;

  const rawCals = b.allowed_calendars;
  const calIds  = rawCals ? [].concat(rawCals).filter(Boolean).join(',') : '';

  const existing = await getConfig(locationId);
  const cols = { deposit_type: dep_type, allowed_calendar_ids: calIds || null };
  if (dep_type === 'percentage') { cols.deposit_percentage = dep_val; cols.deposit_amount = 0; }
  else { cols.deposit_amount = dep_val; cols.deposit_percentage = 0; }

  const isNewHpKey = hp_key && !hp_key.includes('\u2022');
  const isNewPit   = pit_key && !pit_key.includes('\u2022');
  if (isNewHpKey) cols.handypay_api_key = hp_key;
  if (isNewPit)  { cols.crm_access_token = pit_key; cols.crm_refresh_token = null; }

  try {
    if (existing) {
      const sets = [], vals = [];
      let i = 1;
      for (const [k, v] of Object.entries(cols)) { sets.push(`${k}=$${i++}`); vals.push(v); }
      sets.push('updated_at=NOW()');
      vals.push(locationId);
      await pool.query(`UPDATE merchant_configs SET ${sets.join(',')} WHERE location_id=$${i}`, vals);
    } else {
      await pool.query(
        `INSERT INTO merchant_configs (location_id,handypay_api_key,deposit_type,deposit_amount,deposit_percentage,crm_access_token,crm_refresh_token,mode,allowed_calendar_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'test',$8)`,
        [locationId, hp_key||'', dep_type, dep_type==='fixed'?dep_val:0, dep_type==='percentage'?dep_val:0, pit_key||'', null, calIds||null]
      );
    }
    const finalKey = isNewHpKey ? hp_key : (existing && existing.handypay_api_key) || '';
    if (isNewHpKey && finalKey) await registerWebhook(finalKey, locationId).catch(()=>{});
    // Render the page directly — no redirect to avoid ERR_TOO_MANY_REDIRECTS on Vercel
    req.query.saved = 'true';
    return handleGet(req, res, locationId);
  } catch(e) {
    return res.status(500).send('Error: ' + e.message);
  }
}

async function handleGet(req, res, locationId) {
  const installed = req.query.installed === 'true';
  const saved     = req.query.saved     === 'true';

  const [cfg, stats] = await Promise.all([
    getConfig(locationId).catch(() => null),
    locationId ? getStats(locationId) : Promise.resolve({ monthCount:0, monthRevenue:0, totalCount:0, totalRevenue:0, pendingCount:0 })
  ]);

  const token = cfg && cfg.crm_access_token;
  const calendars = token ? await fetchCalendars(token, locationId) : [];
  const savedCalIds = (cfg && cfg.allowed_calendar_ids) ? cfg.allowed_calendar_ids.split(',').map(s=>s.trim()).filter(Boolean) : [];

  const mask   = k => k ? k.substring(0,8) + '\u2022'.repeat(18) : '';
  const hpKey  = cfg ? mask(cfg.handypay_api_key || '') : '';
  const pitKey = token ? mask(token) : '';
  const isPit  = !!(cfg && !cfg.crm_refresh_token && token);
  const isConn = !!(cfg && cfg.handypay_api_key);
  const hasWebhook = !!(cfg && cfg.handypay_webhook_id);
  const depType= (cfg && cfg.deposit_type) || 'percentage';
  const depVal = depType==='percentage' ? ((cfg && cfg.deposit_percentage) || 30) : ((cfg && cfg.deposit_amount) || 5000);
  const fmtJMD = n => 'J$' + Number(n||0).toLocaleString();

  var makeStep = function(label, done, hint, optional) {
    var icon = done ? '&#9989;' : (optional ? '&#128161;' : '&#11093;');
    var bg   = done ? '#f0fdf4' : '#fafafa';
    var bdr  = done ? '#bbf7d0' : '#e2e8f0';
    var col  = done ? '#065f46' : (optional ? '#78716c' : '#1a1a2e');
    var hH   = (!done && hint) ? '<div style="font-size:11px;color:#888;margin-top:2px">'+hint+'</div>' : '';
    var optL = optional ? ' <span style="font-weight:400;color:#94a3b8">(optional)</span>' : '';
    return '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:'+bg+';border-radius:8px;border:1px solid '+bdr+'">'+'<span style="font-size:15px">'+icon+'</span>'+'<div><div style="font-size:13px;font-weight:600;color:'+col+'">'+label+optL+'</div>'+hH+'</div>'+'</div>';
  };

  const calCheckboxes = calendars.length > 0
    ? calendars.map(c => {
        const chk = savedCalIds.includes(c.id) ? ' checked' : '';
        const esc = c.name.replace(/</g,'&lt;').replace(/>/g,'&gt;');
        return `<label class="cal-row"><input type="checkbox" name="allowed_calendars" value="${c.id}"${chk}><span>${esc}</span></label>`;
      }).join('')
    : '<p class="help" style="margin:0">No calendars found. Save your GHL key first, then reload this page.</p>';

  const webhookCard = `<div class="card"><div class="card-title"><span>&#128279;</span> Webhook Status</div>
<div class="wh-status ${hasWebhook?'wh-ok':'wh-warn'}">${hasWebhook?'&#9989; HandyPay webhook registered automatically':'&#9888;&#65039; Not registered &mdash; save your HandyPay API key to activate'}</div>
<div class="wh-row"><code class="wh-url">${WEBHOOK_URL}</code><button type="button" class="copy-btn" onclick="copyWh(this)">Copy URL</button></div>
<div class="help">If webhook fails in HandyPay dashboard, paste the URL above manually.</div></div>`;

  const calCard = `<div class="card"><div class="card-title"><span>&#128197;</span> Calendar Filters <span class="pit-badge" style="background:#f0fdf4;color:#166534">Optional</span></div>
<div class="info" style="margin-bottom:14px">Select which calendars trigger deposit collection. Leave <strong>all unchecked</strong> to collect deposits from every booking regardless of calendar.</div>
<div class="cal-list">${calCheckboxes}</div></div>`;

  var step2 = !!(cfg && cfg.handypay_api_key);
  var step3 = isPit;
  var step4 = stats.totalCount > 0;
  var allReady = step2 && step3;
  var setupCard = allReady ? '' :
    '<div class="card" style="border:2px solid #6366f1">'
    +'<div class="card-title"><span>&#128640;</span> Quick Setup</div>'
    +'<div style="font-size:12px;color:#64748b;margin-bottom:12px">Complete these 3 steps to go live.</div>'
    +'<div style="display:flex;flex-direction:column;gap:8px">'
    +makeStep('App installed', true)
    +makeStep('HandyPay API key connected', step2, 'Enter your key in HandyPay Configuration below')
    +makeStep('GHL Location API key (PIT)', step3, 'Required for SMS deposit links &mdash; see section below')
    +makeStep('Test payment completed', step4, 'Book a test appointment to verify the full flow', true)
    +'</div></div>';

  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HandyPay Settings</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f6fa;min-height:100vh;padding:24px 16px}.wrap{max-width:680px;margin:0 auto}.hdr{display:flex;align-items:center;gap:12px;margin-bottom:24px}.hdr img{width:40px;height:40px;border-radius:10px}.hdr h1{font-size:20px;font-weight:800;color:#1a1a2e}.hdr .sub{margin-top:4px;display:flex;gap:6px;flex-wrap:wrap}.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:700}.conn{background:#d1fae5;color:#065f46}.pit{background:#dbeafe;color:#1e40af}.oauth{background:#fef3c7;color:#92400e}.disc{background:#fee2e2;color:#991b1b}.toast{padding:12px 16px;border-radius:10px;margin-bottom:20px;font-size:14px;font-weight:600}.toast.ok{background:#d1fae5;border:1px solid #6ee7b7;color:#065f46}.toast.inst{background:#dbeafe;border:1px solid #93c5fd;color:#1e40af}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}.stat{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.07)}.stat-lbl{font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}.stat-val{font-size:20px;font-weight:800;color:#1a1a2e;line-height:1.1}.stat-sub{font-size:11px;color:#aaa;margin-top:3px}.card{background:#fff;border-radius:14px;box-shadow:0 1px 6px rgba(0,0,0,.08);padding:24px;margin-bottom:16px}.card-title{font-size:15px;font-weight:700;color:#1a1a2e;margin-bottom:16px;display:flex;align-items:center;gap:8px}.pit-badge{background:#dbeafe;color:#1e40af;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700}label{display:block;font-size:13px;font-weight:600;color:#555;margin-bottom:6px}input[type=text],select{width:100%;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:14px;color:#1a1a2e;background:#fff;transition:border .2s}input:focus,select:focus{outline:none;border-color:#6366f1}.field{margin-bottom:16px}.help{font-size:11px;color:#999;margin-top:5px;line-height:1.6}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.info{background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:14px 16px;margin-bottom:16px;font-size:13px;color:#0369a1;line-height:1.6}button[type=submit]{width:100%;padding:13px;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;margin-top:8px}button[type=submit]:hover{opacity:.9}.wh-status{padding:10px 14px;border-radius:8px;font-size:13px;font-weight:600;margin-bottom:12px}.wh-ok{background:#d1fae5;color:#065f46}.wh-warn{background:#fef3c7;color:#92400e}.wh-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}.wh-url{font-size:12px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:6px 10px;flex:1;word-break:break-all;font-family:monospace}.copy-btn{padding:6px 14px;background:#6366f1;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}.copy-btn:hover{opacity:.85}.cal-list{display:flex;flex-direction:column;gap:8px}.cal-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:8px;cursor:pointer;transition:border .15s}.cal-row:hover{border-color:#6366f1;background:#fafafe}.cal-row input{width:16px;height:16px;accent-color:#6366f1;cursor:pointer}.cal-row span{font-size:13px;color:#1a1a2e;font-weight:500}@media(max-width:480px){.stats{grid-template-columns:1fr 1fr}.row{grid-template-columns:1fr}}</style></head><body><div class="wrap"><div class="hdr"><img src="${LOGO_URL}" alt="HP"><div><h1>HandyPay Settings</h1><div class="sub">${isConn?`<span class="badge conn">&#9679; Connected</span>${isPit?'<span class="badge pit">&#9889; PIT Mode</span>':'<span class="badge oauth">&#8635; OAuth Mode</span>'}`:'<span class="badge disc">&#9675; Not connected</span>'}</div></div></div>${installed?'<div class="toast inst">&#9989; App installed. Enter your API keys below to activate.</div>':''}${saved?'<div class="toast ok">&#9989; Settings saved!</div>':''}${setupCard}<div class="stats"><div class="stat"><div class="stat-lbl">This Month</div><div class="stat-val">${stats.monthCount}</div><div class="stat-sub">deposits paid</div></div><div class="stat"><div class="stat-lbl">Monthly Revenue</div><div class="stat-val" style="font-size:15px">${fmtJMD(stats.monthRevenue)}</div><div class="stat-sub">from deposits</div></div><div class="stat" style="cursor:pointer" onclick="window.location.href='/api/deposits?location_id=${locationId}'"><div class="stat-lbl">Pending</div><div class="stat-val" style="color:#d97706">${stats.pendingCount}</div><div class="stat-sub">view all \u2192</div></div></div><form method="POST" action="/api/settings?location_id=${locationId||''}"><div class="card"><div class="card-title"><span>&#128179;</span> HandyPay Configuration</div><div class="field"><label>HandyPay API Key</label><input type="text" name="hp_api_key" value="${hpKey}" placeholder="hp_live_..."><div class="help">Get your key from HandyPay dashboard. Use hp_test_... for testing.</div></div><div class="row"><div class="field"><label>Deposit Type</label><select name="deposit_type" id="dt" onchange="upd()"><option value="percentage"${depType==='percentage'?' selected':''}>Percentage (%)</option><option value="fixed"${depType==='fixed'?' selected':''}>Fixed Amount (JMD)</option></select></div><div class="field"><label id="dl">${depType==='percentage'?'Deposit %':'Amount (JMD)'}</label><input type="text" name="deposit_value" id="dv" value="${depVal}" placeholder="${depType==='percentage'?'30':'5000'}"></div></div></div>${webhookCard}${calCard}<div class="card"><div class="card-title"><span>&#9889;</span> GHL Location API Key <span class="pit-badge">No Expiry</span></div><div class="info"><strong>Why this matters:</strong> OAuth tokens expire hourly. A Location API Key never expires &mdash; no 401 errors at scale.<br><br><strong>Where to find it:</strong> Settings &rarr; Business Profile &rarr; scroll to <strong>API Keys</strong>.</div><div class="field"><label>GHL Location API Key <span style="color:#6366f1">(PIT)</span></label><input type="text" name="ghl_pit_key" value="${pitKey}" placeholder="eyJhbGci..."><div class="help">${isPit?'&#9889; PIT mode active &mdash; token never expires.':'&#9888;&#65039; Add Location API Key to enable PIT mode.'}</div></div></div><input type="hidden" name="pit_auth" value="${pitKey}"><button type="submit">Save Settings</button></form></div><script>function upd(){var t=document.getElementById('dt').value;document.getElementById('dl').textContent=t==='percentage'?'Deposit %':'Amount (JMD)';document.getElementById('dv').placeholder=t==='percentage'?'30':'5000';}function copyWh(btn){navigator.clipboard.writeText('${WEBHOOK_URL}').then(function(){btn.textContent='Copied!';setTimeout(function(){btn.textContent='Copy URL';},2000);}).catch(function(){btn.textContent='Copy URL';});}<\/script></body></html>`);
}

module.exports = async function handler(req, res) {
  const locationId = (req.query && (req.query.location_id || req.query.locationId)) || '';
  if (req.method === 'POST') return handlePost(req, res, locationId);
  return handleGet(req, res, locationId);
};
