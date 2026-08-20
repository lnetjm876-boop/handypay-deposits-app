// api/debug-log.js — capture client-side debug events to Neon
// Used by api/pay.js iframe to log all postMessages + page state
'use strict';
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
async function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (req.body) { try { return JSON.parse(req.body.toString()); } catch (e) { return {}; } }
  return new Promise(function (resolve) {
    let raw = '';
    req.on('data', function (c) { raw += c; });
    req.on('end', function () { try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); } });
    req.on('error', function () { resolve({}); });
  });
}
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const body = await parseBody(req);
  const label = String(body.label || 'unknown').substring(0, 80);
  const dataStr = JSON.stringify(body.data !== undefined ? body.data : body).substring(0, 490);
  const id = 'dbg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  try {
    await pool.query(
      `INSERT INTO payment_logs (session_id, location_id, payment_type, status, amount, created_at)
       VALUES ($1, $2, 'debug', $3, 0, NOW())`,
      [id, label, dataStr]
    );
    console.log('[debug-log] stored:', label, dataStr.substring(0, 120));
  } catch (e) {
    console.error('[debug-log] DB error:', e.message);
  }
  res.json({ ok: true, id });
};
