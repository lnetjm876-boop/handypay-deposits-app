// lib/ghl.js — Thin GHL API helpers
// updateContactFields + addContactTag — imported by webhook-hp.js
'use strict';
const GHL_API = 'https://services.leadconnectorhq.com';
const V = '2021-07-28';

async function updateContactFields(token, locationId, contactId, fieldMap) {
  if (!token || !contactId) return false;
  const customFields = Object.entries(fieldMap).map(([key, field_value]) => ({
    key,
    field_value: String(field_value == null ? '' : field_value)
  }));
  try {
    const r = await fetch(`${GHL_API}/contacts/${contactId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Version: V },
      body: JSON.stringify({ locationId, customFields })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => String(r.status));
      console.error('[ghl.updateContactFields]', r.status, t.slice(0, 120));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[ghl.updateContactFields] error:', e.message);
    return false;
  }
}

async function addContactTag(token, contactId, tags) {
  if (!token || !contactId || !tags.length) return false;
  try {
    const r = await fetch(`${GHL_API}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Version: V },
      body: JSON.stringify({ tags })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => String(r.status));
      console.error('[ghl.addContactTag]', r.status, t.slice(0, 120));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[ghl.addContactTag] error:', e.message);
    return false;
  }
}

module.exports = { updateContactFields, addContactTag };
