'use strict';
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

/* ---------------- Settings (environment variables) ---------------- */
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';   // set a strong one before going live
const UPI_ID = (process.env.UPI_ID || '').trim();
const PAYEE = process.env.PAYEE_NAME || 'Regional College';
const MAX_PASSES = Number(process.env.MAX_PASSES || 0);              // maximum PEOPLE (a couple pass = 2). 0 = no limit

/* Prices are decided here on the server. The browser never sends an amount. */
const PRICE = { student_first_year: 200, student: 300, single: 300, couple: 500 };
const priceFor = (type, ticket, year) =>
  type === 'insider' ? (year === 1 ? PRICE.student_first_year : PRICE.student) : (ticket === 'couple' ? PRICE.couple : PRICE.single);

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }
const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const defaultPassword = ADMIN_PASSWORD === 'change-me';
if (defaultPassword) console.warn(local
  ? 'WARNING: ADMIN_PASSWORD is the default. Fine for testing only.'
  : 'WARNING: ADMIN_PASSWORD is not set. The committee desk is DISABLED until you set it.');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });
pool.on('error', e => console.error('Database pool error:', e.message));
const q = (text, params) => pool.query(text, params);

/* ---------------- Database (creates and upgrades the table automatically) ---------------- */
const init = (async () => {
  await q(`CREATE TABLE IF NOT EXISTS regs(
    id SERIAL PRIMARY KEY,
    "passNo" TEXT UNIQUE, name TEXT, phone TEXT UNIQUE, email TEXT,
    type TEXT, detail TEXT, amount INTEGER,
    status TEXT DEFAULT 'pending', "checkedIn" INTEGER DEFAULT 0,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP, utr TEXT)`);
  /* Upgrade from the older version: safe to run every time, old rows are kept. */
  await q(`ALTER TABLE regs
    ADD COLUMN IF NOT EXISTS ticket TEXT DEFAULT 'single',
    ADD COLUMN IF NOT EXISTS guests INTEGER DEFAULT 1,
    ADD COLUMN IF NOT EXISTS "year" INTEGER,
    ADD COLUMN IF NOT EXISTS partner TEXT,
    ADD COLUMN IF NOT EXISTS "paidAmount" INTEGER`);
  /* One UPI transaction ID can only be used for one pass. */
  try { await q(`CREATE UNIQUE INDEX IF NOT EXISTS regs_utr_uq ON regs(utr) WHERE utr IS NOT NULL AND utr <> ''`); }
  catch (e) { console.warn('Could not enforce unique UTR (duplicate UTRs already exist):', e.message); }
})();

/* ---------------- Helpers ---------------- */
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const phoneOf = s => { let d = String(s ?? '').replace(/\D/g, ''); if (d.length === 12 && d.startsWith('91')) d = d.slice(2); return d.slice(0, 10); };
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const YEAR = ['', '1st', '2nd', '3rd', '4th'];

const publicView = r => ({
  passNo: r.passNo, name: r.name, type: r.type, ticket: r.ticket || 'single', guests: r.guests || 1,
  year: r.year || null, detail: r.detail, amount: r.amount, paidAmount: r.paidAmount ?? null,
  status: r.status, checkedIn: !!r.checkedIn, utr: r.utr || ''
});

/* People already booked (a couple pass counts as 2). */
const peopleBooked = async db => Number((await db.query('SELECT COALESCE(SUM(guests),0) AS c FROM regs')).rows[0].c);

/* ---------------- App ---------------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '10kb' }));

const page = n => [path.join(__dirname, 'public', n), path.join(__dirname, n)].find(f => fs.existsSync(f));
app.get(['/', '/index.html'], (req, res) => page('index.html') ? res.sendFile(page('index.html')) : res.status(404).send('index.html is missing'));
app.get('/admin.html', (req, res) => { res.set('X-Robots-Tag', 'noindex'); page('admin.html') ? res.sendFile(page('admin.html')) : res.status(404).send('admin.html is missing'); });
app.get('/healthz', (req, res) => res.send('ok'));

/* ---------- Rate limits ---------- */
/* Campus Wi-Fi shares one public IP, so the public limit is generous. */
const hits = new Map();
const fails = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) { const f = v.filter(t => now - t < 600000); f.length ? hits.set(k, f) : hits.delete(k); }
  for (const [k, v] of fails) { const f = v.filter(t => now - t < 900000); f.length ? fails.set(k, f) : fails.delete(k); }
}, 300000).unref();

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/admin') || req.path === '/config') return next();
  const now = Date.now(), list = (hits.get(req.ip) || []).filter(t => now - t < 600000);
  list.push(now); hits.set(req.ip, list);
  list.length > 200 ? res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' }) : next();
});

/* ---------- Public (students, no sign-in) ---------- */
app.get('/api/config', ah(async (req, res) => {
  await init;
  res.json({
    upiId: UPI_ID, payee: PAYEE, prices: PRICE,
    left: MAX_PASSES ? Math.max(0, MAX_PASSES - await peopleBooked(pool)) : null
  });
}));

app.post('/api/register', ah(async (req, res) => {
  await init;
  const b = req.body || {};
  const name = clean(b.name, 60), phone = phoneOf(b.phone), email = clean(b.email, 80);
  const type = b.type === 'outsider' ? 'outsider' : 'insider';
  if (name.length < 3) throw new HttpError(400, 'Enter your full name.');
  if (!/^\d{10}$/.test(phone)) throw new HttpError(400, 'Enter a valid 10-digit mobile number.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email or leave it empty.');

  let ticket = 'single', guests = 1, year = null, partner = '', detail = 'Outsider';
  if (type === 'insider') {
    year = Number(b.year);
    const course = clean(b.course || b.detail, 60);   // "detail" is only a fallback for an older cached page
    if (![1, 2, 3, 4].includes(year)) throw new HttpError(400, 'Select your year of study.');
    if (!course) throw new HttpError(400, 'Enter your course.');
    detail = course + ' · ' + YEAR[year] + ' year';
  } else if (b.ticket === 'couple') {
    ticket = 'couple'; guests = 2; partner = clean(b.partner, 60);
    if (partner.length < 3) throw new HttpError(400, "Enter your partner's full name.");
    detail = 'Outsider · Couple with ' + partner;
  }
  const amount = priceFor(type, ticket, year);

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(7426)');   // one registration at a time, so the pass limit cannot be exceeded
    if (MAX_PASSES) {
      const left = MAX_PASSES - await peopleBooked(db);
      if (left <= 0) throw new HttpError(409, 'All passes are booked. Contact the Cultural Committee.');
      if (guests > left) throw new HttpError(409, 'Only ' + left + ' spot' + (left === 1 ? '' : 's') + ' left. A couple pass needs 2.');
    }
    if ((await db.query('SELECT 1 FROM regs WHERE phone=$1', [phone])).rowCount)
      throw new HttpError(409, 'This mobile number is already registered. Use "Find my pass".');
    let passNo;
    do { passNo = 'RC-' + crypto.randomInt(10000, 100000); }
    while ((await db.query('SELECT 1 FROM regs WHERE "passNo"=$1', [passNo])).rowCount);
    const r = await db.query(
      'INSERT INTO regs("passNo",name,phone,email,type,ticket,guests,"year",partner,detail,amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [passNo, name, phone, email, type, ticket, guests, year, partner, detail, amount]);
    await db.query('COMMIT');
    res.json(publicView(r.rows[0]));
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    if (e.code === '23505') throw new HttpError(409, 'This mobile number is already registered. Use "Find my pass".');
    throw e;
  } finally { db.release(); }
}));

app.post('/api/utr', ah(async (req, res) => {
  await init;
  const b = req.body || {};
  const passNo = clean(b.passNo, 12).toUpperCase(), phone = phoneOf(b.phone);
  const utr = clean(b.utr, 30).replace(/\s/g, '').toUpperCase();
  const paidAmount = Number(b.paidAmount);
  if (!/^[A-Z0-9]{6,30}$/.test(utr)) throw new HttpError(400, 'Enter the full UPI transaction ID (letters and numbers only).');
  if (!Number.isInteger(paidAmount) || paidAmount < 1 || paidAmount > 99999) throw new HttpError(400, 'Enter the amount you paid, in rupees.');
  const cur = await q('SELECT status FROM regs WHERE "passNo"=$1 AND phone=$2', [passNo, phone]);
  if (!cur.rowCount) throw new HttpError(404, 'Pass not found.');
  if (cur.rows[0].status === 'paid') throw new HttpError(409, 'Your payment is already confirmed.');
  try { await q('UPDATE regs SET utr=$1, "paidAmount"=$2 WHERE "passNo"=$3 AND phone=$4', [utr, paidAmount, passNo, phone]); }
  catch (e) { if (e.code === '23505') throw new HttpError(409, 'This transaction ID is already used for another pass. Check it and try again.'); throw e; }
  res.json({ ok: true });
}));

app.get('/api/pass', ah(async (req, res) => {
  await init;
  const r = await q('SELECT * FROM regs WHERE "passNo"=$1 AND phone=$2', [clean(req.query.passNo, 12).toUpperCase(), phoneOf(req.query.phone)]);
  if (!r.rowCount) throw new HttpError(404, 'No pass found. Check the pass number and mobile number.');
  res.json(publicView(r.rows[0]));
}));

/* ---------- Admin (committee, password) ---------- */
app.use('/api/admin', (req, res, next) => {
  if (defaultPassword && !local) return res.status(503).json({ error: 'Set the ADMIN_PASSWORD environment variable first.' });
  const now = Date.now(), recent = (fails.get(req.ip) || []).filter(t => now - t < 900000);
  if (recent.length >= 8) return res.status(429).json({ error: 'Too many wrong passwords. Try again in 15 minutes.' });
  if (crypto.timingSafeEqual(sha(req.get('x-admin-key') || ''), sha(ADMIN_PASSWORD))) return next();
  recent.push(now); fails.set(req.ip, recent);
  res.status(401).json({ error: 'Wrong password.' });
});

const rid = req => Number(req.params.id) || 0;
const done = (res, r) => r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Registration not found.' });

app.get('/api/admin/regs', ah(async (req, res) => { await init; res.json((await q('SELECT * FROM regs ORDER BY id DESC')).rows); }));
app.post('/api/admin/:id/pay', ah(async (req, res) => done(res, await q(`UPDATE regs SET status='paid' WHERE id=$1`, [rid(req)]))));
app.post('/api/admin/:id/unpay', ah(async (req, res) => done(res, await q(`UPDATE regs SET status='pending', "checkedIn"=0 WHERE id=$1`, [rid(req)]))));
app.post('/api/admin/:id/checkin', ah(async (req, res) => done(res, await q(`UPDATE regs SET "checkedIn" = 1 - "checkedIn" WHERE id=$1 AND status='paid'`, [rid(req)]))));
app.delete('/api/admin/:id', ah(async (req, res) => done(res, await q('DELETE FROM regs WHERE id=$1', [rid(req)]))));

app.get('/api/admin/export', ah(async (req, res) => {
  /* A leading = + - @ would be run as a formula in Excel, so it is defused. */
  const cell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const cols = ['passNo', 'name', 'phone', 'email', 'type', 'ticket', 'guests', 'year', 'detail', 'partner', 'amount', 'paidAmount', 'utr', 'status', 'checkedIn', 'createdAt'];
  const rows = (await q('SELECT * FROM regs ORDER BY id')).rows;
  res.type('text/csv; charset=utf-8').send('\ufeff' + [cols.join(',')].concat(
    rows.map(r => cols.map(c => cell(r[c] instanceof Date ? r[c].toISOString() : r[c])).join(','))).join('\n'));
}));

/* ---------- Errors ---------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  console.error(err);
  res.status(500).json({ error: 'Server error. Try again.' });
});

init.then(() => app.listen(PORT, () => console.log('Dandiya Night site running on port ' + PORT)))
    .catch(e => { console.error('Database connection failed:', e.message); process.exit(1); });
