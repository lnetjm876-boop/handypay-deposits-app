const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
  if (req.query.secret !== process.env.INIT_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    await pool.query(`
      ALTER TABLE payment_logs
        ADD COLUMN IF NOT EXISTS record_payment_done BOOLEAN DEFAULT NULL;
    `);
    const check = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'payment_logs' AND column_name = 'record_payment_done'
    `);
    const exists = check.rows.length > 0;
    res.json({ ok: true, column_added: exists, message: 'Schema patched — record_payment_done column ready' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
