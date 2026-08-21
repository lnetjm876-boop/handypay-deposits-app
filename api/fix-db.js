// api/fix-db.js
// One-time DB scale fixes: add indexes + clear debug_messages
// Call: POST /api/fix-db?secret=handypay-init-2026-lnet
// Safe to call multiple times (IF NOT EXISTS guards).
'use strict';

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
  idleTimeoutMillis: 10000
});

module.exports = async function handler(req, res) {
  const secret = req.query.secret || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (secret !== process.env.INIT_SECRET && secret !== 'handypay-init-2026-lnet') {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'POST or GET only' });
  }

  const results = {};
  const errors  = {};

  // 1. Index: payment_logs.session_id (most queried column — every poll)
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_pl_session_id ON payment_logs(session_id)');
    results.idx_session_id = 'ok';
  } catch(e) { errors.idx_session_id = e.message; }

  // 2. Index: payment_logs.location_id (scopes queries per sub-account)
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_pl_location_id ON payment_logs(location_id)');
    results.idx_location_id = 'ok';
  } catch(e) { errors.idx_location_id = e.message; }

  // 3. Index: payment_logs.status (webhook idempotency checks)
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_pl_status ON payment_logs(status)');
    results.idx_status = 'ok';
  } catch(e) { errors.idx_status = e.message; }

  // 4. Composite index: (location_id, status, created_at) for session dedup queries
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_pl_loc_status_ts ON payment_logs(location_id, status, created_at DESC)');
    results.idx_loc_status_ts = 'ok';
  } catch(e) { errors.idx_loc_status_ts = e.message; }

  // 5. Truncate debug_messages (DB bomb prevention)
  // Keeps last 500 rows for recent debugging, deletes the rest.
  let dmBefore = 0, dmAfter = 0;
  try {
    const countBefore = await pool.query('SELECT COUNT(*)::int AS n FROM debug_messages');
    dmBefore = countBefore.rows[0].n;
    if (dmBefore > 500) {
      await pool.query(`
        DELETE FROM debug_messages
        WHERE id NOT IN (
          SELECT id FROM debug_messages
          ORDER BY id DESC
          LIMIT 500
        )
      `);
    }
    const countAfter = await pool.query('SELECT COUNT(*)::int AS n FROM debug_messages');
    dmAfter = countAfter.rows[0].n;
    results.debug_messages = { before: dmBefore, after: dmAfter, deleted: dmBefore - dmAfter };
  } catch(e) {
    // debug_messages may not have an id column — try ctid fallback
    try {
      await pool.query('TRUNCATE TABLE debug_messages');
      results.debug_messages = { truncated: true, before: dmBefore };
    } catch(e2) { errors.debug_messages = e2.message; }
  }

  // 6. Report payment_logs row count
  try {
    const plCount = await pool.query('SELECT COUNT(*)::int AS n FROM payment_logs');
    results.payment_logs_rows = plCount.rows[0].n;
  } catch(e) { errors.payment_logs_rows = e.message; }

  // 7. Report merchant_configs count
  try {
    const mcCount = await pool.query('SELECT COUNT(*)::int AS n FROM merchant_configs');
    results.merchant_configs_rows = mcCount.rows[0].n;
  } catch(e) { errors.merchant_configs_rows = e.message; }

  const hasErrors = Object.keys(errors).length > 0;
  res.status(hasErrors ? 207 : 200).json({
    ok: !hasErrors,
    ts: new Date().toISOString(),
    results,
    errors: hasErrors ? errors : undefined
  });
};
