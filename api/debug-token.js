// api/debug-token.js — diagnose Neon token + GHL orders API
'use strict';
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async function handler(req, res) {
  const locationId = req.query.locationId || 'tPCmng9TJ7Qc6gG7AaU3';
  const result = { locationId, steps: [] };

  try {
    // Step 1: Get all columns that exist
    const { rows } = await pool.query('SELECT * FROM merchant_configs WHERE location_id=$1 LIMIT 1', [locationId]);
    const cfg = rows[0];
    if (!cfg) { result.steps.push('NOT FOUND in merchant_configs'); return res.json(result); }
    // Show which token columns exist and have values
    const cols = Object.keys(cfg);
    result.columns = cols;
    result.tokenInfo = {
      crm_access_token:  cfg.crm_access_token  ? 'SET (len=' + String(cfg.crm_access_token).length  + ')' : 'NULL',
      crm_refresh_token: cfg.crm_refresh_token ? 'SET (len=' + String(cfg.crm_refresh_token).length + ')' : 'NULL',
      handypay_api_key:  cfg.handypay_api_key  ? 'SET' : 'NULL',
      updated_at:        cfg.updated_at
    };
    result.steps.push('neon: found');

    const token = cfg.crm_access_token || '';
    if (!token) { result.steps.push('NO access token stored'); return res.json(result); }

    // Step 2: Test GHL orders API
    const urls = [
      'https://services.leadconnectorhq.com/payments/orders?altId=' + locationId + '&altType=location&paymentStatus=unpaid&limit=3',
      'https://services.leadconnectorhq.com/payments/orders?altId=' + locationId + '&altType=location&limit=3',
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Version: '2021-07-28' } });
        const body = await r.text();
        result.steps.push('GET ' + new URL(url).search + ' -> ' + r.status + ' | ' + body.substring(0, 300));
        if (r.ok) break;
      } catch (e) { result.steps.push('fetch error: ' + e.message); }
    }
  } catch (e) {
    result.error = e.message;
  }

  res.json(result);
};
