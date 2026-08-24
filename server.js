const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const app = express();

// PASTE CHECK: if copied from chat, verify GHL_API, GHL_CLIENT_ID, GHL_CLIENT_SECRET are NOT corrupted
const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_CLIENT_ID = process.env.GHL_CLIENT_ID;
const GHL_CLIENT_SECRET = process.env.GHL_CLIENT_SECRET;
const HP_BASE = 'https://api.handypay.me/api/v1';
const APP_URL = process.env.APP_URL || 'https://handypay-deposits-app.vercel.app';
const LOGO_URL = 'https://storage.googleapis.com/crm-conversations-ai-production/ask-ai-images/1785549533996/aaf88bbe-7f89-44b6-ba1b-12a6417755f6.png';

app.use('/api/webhooks', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Request logger DISABLED - was writing every request to debug_messages (caused DB bloat)
// app.use(function(req, res, next) {
//   if (req.path === '/api/debug-messages' || req.path === '/api/health') return next();
//   pool.query('INSERT INTO debug_messages (location_id, message, origin) VALUES ($1, $2, $3)',
//     ['req-log', JSON.stringify({ method: req.method, path: req.path, query: req.query, body: req.method === 'POST' ? req.body : undefined, ua: (req.headers['user-agent']||'').substring(0,80), ip: req.ip }), 'request-logger']
//   ).catch(function(){});
//   next();
// });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });