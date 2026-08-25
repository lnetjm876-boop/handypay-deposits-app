// lib/db.js — shared Postgres pool for all Vercel serverless functions
// Each function imports this instead of declaring its own new Pool()
// In serverless, Node.js module cache keeps the pool alive across warm invocations
'use strict';
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000
});

module.exports = pool;
