const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const GHL_API = 'https://services.leadconnectorhq.com';

module.exports = async (req, res) => {
  if (req.query.secret !== process.env.INIT_SECRET) return res.status(403).json({ error: 'forbidden' });
  const locationId = req.query.locationId;
  if (!locationId) return res.status(400).json({ error: 'locationId required' });

  try {
    // Get stored refresh token
    const { rows } = await pool.query('SELECT crm_refresh_token, crm_access_token FROM merchant_configs WHERE location_id=$1', [locationId]);
    if (!rows[0]) return res.status(404).json({ error: 'no merchant config found for this location' });
    if (!rows[0].crm_refresh_token) return res.status(404).json({ error: 'no refresh token stored — re-run OAuth' });

    const refreshToken = rows[0].crm_refresh_token;

    // Call GHL token refresh endpoint
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

    // Update merchant_configs with fresh tokens
    await pool.query(
      'UPDATE merchant_configs SET crm_access_token=$1, crm_refresh_token=$2 WHERE location_id=$3',
      [tokenData.access_token, tokenData.refresh_token || refreshToken, locationId]
    );

    return res.json({ success: true, message: 'Token refreshed and saved to DB', expires_in: tokenData.expires_in });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
