// api/migrate-db.js — Idempotent DB column migration
// Run once after deploy: GET /api/migrate-db?secret=handypay-init-2026-lnet
// All ALTER TABLE IF NOT EXISTS are safe to re-run.
'use strict';

const pool = require('../lib/db');

const INIT_SECRET = process.env.INIT_SECRET || 'handypay-init-2026-lnet';

module.exports = async function handler(req, res) {
  const secret = (req.query && req.query.secret) || '';
  if (secret !== INIT_SECRET) return res.status(401).json({ error: 'unauthorized' });

  const results = [];
  const run = async (sql, label) => {
    try {
      await pool.query(sql);
      results.push({ label, ok: true });
    } catch (e) {
      results.push({ label, ok: false, error: e.message });
    }
  };

  await run(
    'ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS payment_intent_id TEXT',
    'payment_intent_id'
  );
  await run(
    'ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS entity_id TEXT',
    'entity_id'
  );
  await run(
    'ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS ghl_transaction_id TEXT',
    'ghl_transaction_id'
  );
  await run(
    'ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS record_payment_done BOOLEAN DEFAULT FALSE',
    'record_payment_done'
  );
  await run(
    'ALTER TABLE payment_logs ADD COLUMN IF NOT EXISTS appointment_id_v2 TEXT',
    'appointment_id_v2'
  );
  await run(
    'ALTER TABLE merchant_configs ADD COLUMN IF NOT EXISTS deposit_percentage NUMERIC DEFAULT 30',
    'deposit_percentage'
  );

  const allOk = results.every(r => r.ok);
  console.log('[migrate-db] results:', JSON.stringify(results));
  return res.json({ ok: allOk, results });
};
