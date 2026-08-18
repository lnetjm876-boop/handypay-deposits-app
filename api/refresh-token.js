// api/refresh-token.js — Token refresh + PIT mode support
// PIT mode: if crm_refresh_token is NULL/empty, the stored token is a
// GHL Private Integration Token (never expires) — return success immediately.
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const GHL_API = 'https://services.leadconnectorhq.com';

module.exports = async (req, res) => {
  if (req.query.secret !== process.env.INIT_SECRET) return res.status(403).json({ error: 'forbidden' });
  const locationId = req.query.locationId;
  if (!locationId) return res.status(400).json({ error: 'locationId required' });

  try {
    // Get stored tokens
    const { rows } = await pool.query('SELECT crm_refresh_token, crm_access_token FROM merchant_configs WHERE location_id=$1', [locationId]);
    if (!rows[0]) return res.status(404).json({ error: 'no merchant config found for this location' });

    // ---- MANUAL INJECTION MODE ----
    // If manual_token is provided, skip GHL refresh and store directly
    // Pass manual_refresh= (empty) to switch location to PIT mode
    if (req.query.manual_token) {
      // If manual_refresh is explicitly passed (even empty), use it; otherwise keep existing
      const hasManualRefresh = Object.prototype.hasOwnProperty.call(req.query, 'manual_refresh');
      const newRefresh = hasManualRefresh ? (req.query.manual_refresh || null) : (rows[0].crm_refresh_token || null);
      await pool.query(
        'UPDATE merchant_configs SET crm_access_token=$1, crm_refresh_token=$2 WHERE location_id=$3',
        [req.query.manual_token, newRefresh, locationId]
      );
      const mode = newRefresh ? 'oauth_manual' : 'pit_manual';
      return res.json({ success: true, mode, message: mode === 'pit_manual' ? 'Token stored as permanent PIT — no future refresh needed.' : 'Token manually stored. Will auto-refresh using stored refresh_token.' });
    }

    // ---- PIT MODE (permanent, never expires) ----
    // If no refresh token stored, the access token is a GHL Private Integration Token.
    // These never expire — return success without touching GHL.
    if (!rows[0].crm_refresh_token) {
      return res.json({
        success: true,
        mode: 'pit',
        message: 'PIT mode — GHL Private Integration Token in use. No refresh needed. Token is permanent.'
      });
    }

    // ---- AUTO REFRESH MODE (OAuth token rotation) ----
    const refreshToken = rows[0].crm_refresh_token;

    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', process.env.GHL_CLIENT_ID);
    params.append('client_secret', process.env.GHL_CLIENT_SECRET);
    params.append('refresh_token', refreshToken);
    params.append('redirect_uri', (process.env.APP_URL || 'https://handypay-deposits-app.vercel.app') + '/api/oauth/callback');

    const tokenRes = await fetch(GHL_API + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      return res.json({ success: false, status: tokenRes.status, error: 'GHL token refresh failed', details: tokenData });
    }

    await pool.query(
      'UPDATE merchant_configs SET crm_access_token=$1, crm_refresh_token=$2 WHERE location_id=$3',
      [tokenData.access_token, tokenData.refresh_token || refreshToken, locationId]
    );

    return res.json({ success: true, mode: 'auto_refresh', message: 'Token refreshed and saved to DB', expires_in: tokenData.expires_in });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
