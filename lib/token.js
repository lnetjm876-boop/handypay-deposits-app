// lib/token.js — PIT-aware token resolver (single copy, used by all functions)
// PIT mode: crm_refresh_token IS NULL → return crm_access_token as-is (never expires)
// OAuth mode: refresh via GHL /oauth/token and persist new tokens
'use strict';
const pool = require('./db');
const GHL_API = 'https://services.leadconnectorhq.com';

async function getFreshToken(locationId) {
  const { rows } = await pool.query(
    'SELECT crm_access_token, crm_refresh_token FROM merchant_configs WHERE location_id=$1',
    [locationId]
  );
  const cfg = rows[0];
  if (!cfg || !cfg.crm_access_token) throw new Error('no_config:' + locationId);

  // PIT mode — permanent token, never expires
  if (!cfg.crm_refresh_token) {
    return cfg.crm_access_token;
  }

  // OAuth mode — refresh
  const r = await fetch(GHL_API + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GHL_CLIENT_ID,
      client_secret: process.env.GHL_CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: cfg.crm_refresh_token
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('token_refresh_failed:' + (d.message || r.status));
  await pool.query(
    'UPDATE merchant_configs SET crm_access_token=$1, crm_refresh_token=$2, updated_at=NOW() WHERE location_id=$3',
    [d.access_token, d.refresh_token, locationId]
  );
  return d.access_token;
}

module.exports = { getFreshToken };
