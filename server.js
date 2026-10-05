const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';   // set a strong one before going live
const FEE = { insider: 300, outsider: 400 };
const UPI_ID = process.env.UPI_ID || '';
const MAX_PASSES = Number(process.env.MAX_PASSES || 0);  // 0 = no limit

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }
const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });
const q = (text, params) => pool.query(text, params);

const init = q(`CREATE TABLE IF NOT EXISTS regs(
  id SERIAL PRIMARY KEY,
  "passNo" TEXT UNIQUE, name TEXT, phone TEXT UNIQUE, email TEXT,
  type TEXT, detail TEXT, amount INTEGER,
  status TEXT DEFAULT 'pending', "checkedIn" INTEGER DEFAULT 0,
  "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP, utr TEXT)`);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const page = n => [path.join(__dirname, 'public', n), path.join(__dirname, n)].find(f => fs.existsSync(f));
app.get(['/', '/index.html'], (req, res) => page('index.html') ? res.sendFile(page('index.html')) : res.status(404).send('index.html is missing'));
app.get('/admin.html', (req, res) => page('admin.html') ? res.sendFile(page('admin.html')) : res.status(404).send('admin.html is missing'));
app.get('/healthz', (req, res) => res.send('ok'));

const clean = (s, n) => String(s || '').trim().slice(0, n);
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const publicView = r => ({ passNo: r.passNo, name: r.name, type: r.type, amount: r.amount, status: r.status, checkedIn: !!r.checkedIn, utr: r.utr || '' });

/* ---------- Public (students, no sign-in) ---------- */
const hits = new Map();   // small rate limit: 60 requests / 10 min per IP
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/admin') || req.path === '/config') return next();
  const k = req.ip, now = Date.now(), list = (hits.get(k) || []).filter(t => now - t < 600000);
  list.push(now); hits.set(k, list);
  list.length > 60 ? res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' }) : next();
});

const count = async () => Number((await q('SELECT COUNT(*) AS c FROM regs')).rows[0].c);
app.get('/api/config', ah(async (req, res) => {
  await init;
  res.json({ fee: FEE, upiId: UPI_ID, payee: process.env.PAYEE_NAME || 'Regional College', left: MAX_PASSES ? Math.max(0, MAX_PASSES - await count()) : null });
}));

app.post('/api/register', ah(async (req, res) => {
  await init;
  if (MAX_PASSES && await count() >= MAX_PASSES) return res.status(409).json({ error: 'All passes are booked. Contact the Cultural Committee.' });
  const name = clean(req.body.name, 60), phone = clean(req.body.phone, 10), email = clean(req.body.email, 80);
  const type = req.body.type === 'outsider' ? 'outsider' : 'insider', detail = clean(req.body.detail, 80);
  if (name.length < 3 || !/^\d{10}$/.test(phone) || !detail) return res.status(400).json({ error: 'Enter a valid name, 10-digit mobile number, and details.' });
  if ((await q('SELECT 1 FROM regs WHERE phone=$1', [phone])).rowCount) return res.status(409).json({ error: 'This mobile number is already registered. Use "Find my pass".' });
  for (let i = 0; i < 10; i++) {
    const passNo = 'RC-' + crypto.randomInt(10000, 100000);
    try {
      const r = await q('INSERT INTO regs("passNo",name,phone,email,type,detail,amount) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [passNo, name, phone, email, type, detail, FEE[type]]);
      return res.json(publicView(r.rows[0]));
    } catch (e) {
      if (e.code === '23505' && /phone/.test(e.constraint || e.detail || '')) return res.status(409).json({ error: 'This mobile number is already registered. Use "Find my pass".' });
      if (e.code !== '23505') throw e;
    }
  }
  res.status(500).json({ error: 'Could not register. Try again.' });
}));

app.post('/api/utr', ah(async (req, res) => {
  await init;
  const utr = clean(req.body.utr, 30);
  if (utr.length < 6) return res.status(400).json({ error: 'Enter the full UPI transaction ID.' });
  const r = await q(`UPDATE regs SET utr=$1 WHERE "passNo"=$2 AND phone=$3 AND status<>'paid'`, [utr, clean(req.body.passNo, 12).toUpperCase(), clean(req.body.phone, 10)]);
  r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Pass not found.' });
}));

app.get('/api/pass', ah(async (req, res) => {
  await init;
  const r = await q('SELECT * FROM regs WHERE "passNo"=$1 AND phone=$2', [clean(req.query.passNo, 12).toUpperCase(), clean(req.query.phone, 10)]);
  r.rowCount ? res.json(publicView(r.rows[0])) : res.status(404).json({ error: 'No pass found. Check the pass number and mobile number.' });
}));

/* ---------- Admin (committee, password) ---------- */
app.use('/api/admin', (req, res, next) => {
  crypto.timingSafeEqual(sha(req.get('x-admin-key') || ''), sha(ADMIN_PASSWORD)) ? next() : res.status(401).json({ error: 'Wrong password.' });
});
const id = req => Number(req.params.id) || 0;
app.get('/api/admin/regs', ah(async (req, res) => { await init; res.json((await q('SELECT * FROM regs ORDER BY id DESC')).rows); }));
app.post('/api/admin/:id/pay', ah(async (req, res) => { await q(`UPDATE regs SET status='paid' WHERE id=$1`, [id(req)]); res.json({ ok: true }); }));
app.post('/api/admin/:id/checkin', ah(async (req, res) => { await q('UPDATE regs SET "checkedIn" = 1 - "checkedIn" WHERE id=$1', [id(req)]); res.json({ ok: true }); }));
app.delete('/api/admin/:id', ah(async (req, res) => { await q('DELETE FROM regs WHERE id=$1', [id(req)]); res.json({ ok: true }); }));
app.get('/api/admin/export', ah(async (req, res) => {
  const cell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = (await q('SELECT * FROM regs ORDER BY id')).rows;
  res.type('text/csv; charset=utf-8').send('\ufeff' + ['passNo,name,phone,email,type,detail,amount,status,checkedIn'].concat(
    rows.map(r => [r.passNo, r.name, r.phone, r.email, r.type, r.detail, r.amount, r.status, r.checkedIn].map(cell).join(','))).join('\n'));
}));

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error. Try again.' }); });

init.then(() => app.listen(PORT, () => console.log('Dandiya Night site running on port ' + PORT)))
    .catch(e => { console.error('Database connection failed:', e.message); process.exit(1); });
