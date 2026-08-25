// lib/ghl.js — GHL API utilities shared across all functions
// Replaces copy-pasted addContactTag / addContactNote / fireRecordPayment
// NEW: updateContactFields — writes to contact custom fields to trigger GHL workflows
'use strict';
const GHL_API = 'https://services.leadconnectorhq.com';

// ── Update contact custom fields
// fields: { fieldId: value, ... }  — values are coerced to string
async function updateContactFields(accessToken, contactId, fields) {
  const customFields = Object.entries(fields).map(function([id, val]) {
    return { id: id, value: String(val) };
  });
  const r = await fetch(GHL_API + '/contacts/' + contactId, {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
    body: JSON.stringify({ customFields: customFields })
  });
  if (!r.ok) {
    const t = await r.text().catch(function() { return ''; });
    console.error('[ghl.updateContactFields] ' + r.status, t.slice(0, 200));
  }
  return r.json().catch(function() {});
}

// ── Add tags to contact
async function addContactTag(accessToken, contactId, tags) {
  const r = await fetch(GHL_API + '/contacts/' + contactId + '/tags', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
    body: JSON.stringify({ tags: tags })
  });
  if (!r.ok) console.error('[ghl.addContactTag]', r.status);
  return r.json().catch(function() {});
}

// ── Add note to contact (kept for legacy/admin use; post-payment notes now via GHL workflow)
async function addContactNote(accessToken, contactId, body) {
  const r = await fetch(GHL_API + '/contacts/' + contactId + '/notes', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
    body: JSON.stringify({ body: body })
  });
  if (!r.ok) console.error('[ghl.addContactNote]', r.status);
  return r.json().catch(function() {});
}

// ── Mark GHL invoice as paid
async function fireRecordPayment(invoiceId, locationId, amount, note, token) {
  const r = await fetch(GHL_API + '/invoices/' + invoiceId + '/record-payment', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
    body: JSON.stringify({ locationId: locationId, amountDue: amount, notes: note || 'Paid via HandyPay' })
  });
  if (!r.ok) {
    const t = await r.text().catch(function() { return ''; });
    throw new Error('record-payment ' + r.status + ': ' + t.slice(0, 200));
  }
  return r.json();
}

module.exports = { updateContactFields, addContactTag, addContactNote, fireRecordPayment };
