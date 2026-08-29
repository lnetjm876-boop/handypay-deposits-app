// api/deposits.js — HandyPay Deposits Dashboard
// Shows all deposit sessions for a location: pending / paid / expired
'use strict';

const { Pool } = require('pg');

const LOGO_URL = 'https://storage.googleapis.com/crm-conversations-ai-production/ask-ai-images/1785549533996/aaf88bbe-7f89-44b6-ba1b-12a6417755f6.png';
const APP_URL  = process.env.APP_URL || 'https://handypay-deposits-app.vercel.app';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000
});

async function getLogs(locationId, status) {
  const where = status ? ' AND status = $2' : '';
  const vals  = status ? [locationId, status] : [locationId];
  const { rows } = await pool.query(
    'SELECT session_id,contact_id,appointment_id,amount,currency,status,payment_type,created_at' +
    ' FROM payment_logs WHERE location_id=$1' + where +
    ' ORDER BY created_at DESC LIMIT 100',
    vals
  );
  return rows;
}

async function getCounts(locationId) {
  const { rows } = await pool.query(
    'SELECT status,COUNT(*) AS cnt,COALESCE(SUM(amount),0) AS total' +
    ' FROM payment_logs WHERE location_id=$1 GROUP BY status',
    [locationId]
  );
  const r = { pending:0, paid:0, expired:0, pendingAmt:0, paidAmt:0 };
  rows.forEach(function(row) {
    var c = parseInt(row.cnt)||0, t = parseInt(row.total)||0;
    if (row.status==='pending'){ r.pending=c; r.pendingAmt=t; }
    if (row.status==='paid')   { r.paid=c;    r.paidAmt=t;   }
    if (row.status==='expired'){ r.expired=c;                 }
  });
  return r;
}

module.exports = async function handler(req, res) {
  const locationId = (req.query && (req.query.location_id || req.query.locationId)) || '';
  const filter     = (req.query && req.query.status) || '';

  if (!locationId) {
    res.setHeader('Content-Type','text/html');
    return res.status(400).send('<h2 style="font-family:sans-serif;padding:24px">Missing location_id parameter.</h2>');
  }

  const [logs, counts] = await Promise.all([
    getLogs(locationId, filter || null).catch(function(){ return []; }),
    getCounts(locationId).catch(function(){ return { pending:0, paid:0, expired:0, pendingAmt:0, paidAmt:0 }; })
  ]);

  var fmtAmt = function(n) { return 'J$' + Number(n||0).toLocaleString(); };
  var fmtAge = function(d) {
    var diff = Date.now() - new Date(d).getTime();
    var m = Math.floor(diff/60000);
    if (m < 60)  return m + 'm ago';
    var h = Math.floor(m/60);
    if (h < 24)  return h + 'h ago';
    return Math.floor(h/24) + 'd ago';
  };
  var esc = function(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
  var short = function(s,n) { return s && s.length > n ? s.substring(0,n)+'\u2026' : (s||''); };

  var badge = function(status) {
    var map = { pending:['#fef3c7','#92400e','&#9203; Pending'], paid:['#d1fae5','#065f46','&#9989; Paid'], expired:['#fee2e2','#991b1b','&#128308; Expired'] };
    var b = map[status] || ['#f1f5f9','#475569', esc(status)];
    return '<span style="background:'+b[0]+';color:'+b[1]+';padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">'+b[2]+'</span>';
  };

  var tab = function(label, val) {
    var active = filter === val;
    return '<a href="'+APP_URL+'/api/deposits?location_id='+encodeURIComponent(locationId)+'&status='+val+'" style="padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;'+
      (active ? 'background:#6366f1;color:#fff' : 'color:#64748b;background:#f1f5f9')+
      '">'+label+'</a>';
  };

  var rows = logs.map(function(l) {
    var ghlContact = l.contact_id
      ? '<a href="https://app.gohighlevel.com/v2/location/'+encodeURIComponent(locationId)+'/contacts/detail/'+encodeURIComponent(l.contact_id)+'" target="_blank" style="color:#6366f1;text-decoration:none;font-family:monospace;font-size:11px">'+esc(short(l.contact_id,14))+'</a>'
      : '<span style="color:#ccc">\u2014</span>';
    var appt = l.appointment_id
      ? '<span style="font-family:monospace;font-size:11px;color:#888">'+esc(short(l.appointment_id,14))+'</span>'
      : '<span style="color:#ccc">\u2014</span>';
    return '<tr>'
      +'<td style="padding:12px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#888">'+fmtAge(l.created_at)+'</td>'
      +'<td style="padding:12px 10px;border-bottom:1px solid #f1f5f9">'+badge(l.status)+'</td>'
      +'<td style="padding:12px 10px;border-bottom:1px solid #f1f5f9;font-weight:700;color:#1a1a2e">'+fmtAmt(l.amount)+'</td>'
      +'<td style="padding:12px 10px;border-bottom:1px solid #f1f5f9">'+ghlContact+'</td>'
      +'<td style="padding:12px 10px;border-bottom:1px solid #f1f5f9">'+appt+'</td>'
      +'</tr>';
  }).join('');

  var emptyState = '<div style="text-align:center;padding:48px;color:#aaa">'
    +'<div style="font-size:36px;margin-bottom:12px">&#128235;</div>'
    +'<div style="font-weight:700;font-size:15px;color:#64748b">'+(filter ? 'No '+filter+' deposits' : 'No deposits yet')+'</div>'
    +'<div style="font-size:12px;margin-top:6px">Deposits appear here when clients book appointments</div>'
    +'</div>';

  res.setHeader('Content-Type', 'text/html');
  res.send('<!DOCTYPE html><html><head>'
    +'<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    +'<title>HandyPay Deposits</title>'
    +'<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f6fa;min-height:100vh;padding:24px 16px}.wrap{max-width:900px;margin:0 auto}table{width:100%;border-collapse:collapse}th{text-align:left;padding:10px;font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #f1f5f9}@media(max-width:600px){td:nth-child(4),td:nth-child(5),th:nth-child(4),th:nth-child(5){display:none}}</style>'
    +'</head><body><div class="wrap">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px">'
    +'<div style="display:flex;align-items:center;gap:12px">'
    +'<img src="'+LOGO_URL+'" style="width:36px;height:36px;border-radius:10px">'
    +'<div><h1 style="font-size:20px;font-weight:800;color:#1a1a2e">Deposits</h1>'
    +'<a href="'+APP_URL+'/api/settings?location_id='+encodeURIComponent(locationId)+'" style="font-size:12px;color:#6366f1;text-decoration:none">\u2190 Settings</a></div>'
    +'</div></div>'
    +'<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">'
    +'<div style="background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.07)">'
    +'<div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Pending</div>'
    +'<div style="font-size:22px;font-weight:800;color:#d97706">'+counts.pending+'</div>'
    +'<div style="font-size:11px;color:#aaa;margin-top:3px">'+fmtAmt(counts.pendingAmt)+' waiting</div>'
    +'</div>'
    +'<div style="background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.07)">'
    +'<div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Paid</div>'
    +'<div style="font-size:22px;font-weight:800;color:#065f46">'+counts.paid+'</div>'
    +'<div style="font-size:11px;color:#aaa;margin-top:3px">'+fmtAmt(counts.paidAmt)+' collected</div>'
    +'</div>'
    +'<div style="background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.07)">'
    +'<div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Expired</div>'
    +'<div style="font-size:22px;font-weight:800;color:#dc2626">'+counts.expired+'</div>'
    +'<div style="font-size:11px;color:#aaa;margin-top:3px">links unused</div>'
    +'</div>'
    +'</div>'
    +'<div style="background:#fff;border-radius:14px;box-shadow:0 1px 6px rgba(0,0,0,.08);padding:20px">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px">'
    +'<h2 style="font-size:15px;font-weight:700;color:#1a1a2e">Deposit History</h2>'
    +'<div style="display:flex;gap:6px;flex-wrap:wrap">'
    +tab('All','')+tab('Pending','pending')+tab('Paid','paid')+tab('Expired','expired')
    +'</div></div>'
    +(logs.length > 0
      ? '<table><thead><tr><th>Date</th><th>Status</th><th>Amount</th><th>Contact</th><th>Appointment</th></tr></thead><tbody>'+rows+'</tbody></table>'
      : emptyState)
    +'</div>'
    +'</div></body></html>'
  );
};
