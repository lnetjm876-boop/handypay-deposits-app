// api/debug-token.js — diagnostic: test Neon token against GHL orders API
'use strict';
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async function handler(req, res) {
  const locationId = req.query.locationId || 'tPCmng9TJ7Qc6gG7AaU3';
  const result = { locationId, steps: [] };

  // Step 1: Neon query
  try {
    const { rows } = await pool.query(
      'SELECT location_id, handypay_api_key, crm_access_token IS NOT NULL as has_crm, ghl_access_token IS NOT NULL as has_ghl, crm_refresh_token IS NOT NULL as has_refresh, updated_at FROM merchant_configs WHERE location_id=$1 LIMIT 1',
      [locationId]
    );
    result.neon = rows[0] || null;
    result.steps.push('neon: ' + (rows[0] ? 'found' : 'NOT FOUND'));
    const cfg = rows[0];
    const token = cfg && (cfg.crm_access_token || cfg.ghl_access_token);
    result.hasToken = !!token;
    result.tokenLen = token ? String(token).length : 0;

    // Step 2: Try orders API
    if (token) {
      const urls = [
        'https://services.leadconnectorhq.com/payments/orders?altId=' + locationId + '&altType=location&paymentStatus=unpaid&limit=3',
        'https://services.leadconnectorhq.com/payments/orders?altId=' + locationId + '&altType=location&status=pending&limit=3',
        'https://services.leadconnectorhq.com/payments/orders?altId=' + locationId + '&altType=location&limit=3',
        'https://backend.leadconnectorhq.com/payments/orders?altId=' + locationId + '&altType=location&limit=3',
      ];
      for (const url of urls) {
        try {
          const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Version: '2021-07-28' } });
          const body = await r.text();
          result.steps.push('GET ' + url.split('?')[1] + ' → ' + r.status + ' | ' + body.substring(0, 200));
          if (r.ok) { result.ordersApiWorked = true; break; }
        } catch (e) {
          result.steps.push('error: ' + e.message);
        }
      }
    }
  } catch (e) {
    result.error = e.message;
  }

  res.json(result);
};
