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
const INIT_SECRET = process.env.INIT_SECRET || 'handypay-init-2026-lnet';

// Custom field IDs for GHL-native architecture (created 2026-08-25)
// App writes these fields; GHL workflows read them to send SMS, add tags, add notes.
const CF_DEPOSIT_URL    = '1k66C4LHCyTsf2Zp3koy';  // contact.deposit_payment_url
const CF_DEPOSIT_STATUS = 'U5ZFR70chqhsm17CGyTZ';  // contact.deposit_status
const CF_DEPOSIT_AMOUNT = 'SbbZbk7h0jF4p02SLssW';  // contact.deposit_amount_paid
