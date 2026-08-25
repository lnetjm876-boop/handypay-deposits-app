// lib/db.js — Shared Postgres pool (imported by all Vercel functions)
// Single source of truth for connection config — no more new Pool() in every file.
'use strict';
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000
});
module.exports = pool;
