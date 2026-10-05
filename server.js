const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';   // set a strong one before going live
const FEE = { insider: 300, outsider: 400 };
const UPI_ID = process.env.UPI_ID || '';              // e.g. collegename@upi (optional, shows a Pay button)
const MAX_PASSES = Number(process.env.MAX_PASSES || 0);  // 0 = no limit

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'dandiya.db'));
db.exec(`CREATE TABLE IF NOT EXISTS regs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  passNo TEXT UNIQUE, name TEXT, phone TEXT UNIQUE, email TEXT,
  type TEXT, detail TEXT, amount INTEGER,
  status TEXT DEFAULT 'pending', checkedIn INTEGER DEFAULT 0,
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP)`);

try { db.exec('ALTER TABLE regs ADD COLUMN utr TEXT'); } catch (e) {}   // adds the UPI transaction ID column to older databases

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
const fs = require('fs');
const page = n => [path.join(__dirname, 'public', n), path.join(__dirname, n)].find(f => fs.existsSync(f));   // works even if files are not in /public
app.get(['/', '/index.html'], (q, r) => page('index.html') ? r.sendFile(page('index.html')) : r.status(404).send('index.html is missing'));
app.get('/admin.html', (q, r) => page('admin.html') ? r.sendFile(page('admin.html')) : r.status(404).send('admin.html is missing'));

const clean = (s, n) => String(s || '').trim().slice(0, n);
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const publicView = r => ({ passNo: r.passNo, name: r.name, type: r.type, amount: r.amount, status: r.status, checkedIn: !!r.checkedIn, utr: r.utr || '' });

/* ---------- Public (students, no sign-in) ---------- */
const hits = new Map();   // very small rate limit: 60 requests / 10 min per IP
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/admin') || req.path === '/config') return next();
  const k = req.ip, now = Date.now(), list = (hits.get(k) || []).filter(t => now - t < 600000);
  list.push(now); hits.set(k, list);
  list.length > 60 ? res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' }) : next();
});

const count = () => db.prepare('SELECT COUNT(*) c FROM regs').get().c;
app.get('/api/config', (req, res) => res.json({ fee: FEE, upiId: UPI_ID, payee: process.env.PAYEE_NAME || 'Regional College', left: MAX_PASSES ? Math.max(0, MAX_PASSES - count()) : null }));

app.post('/api/register', (req, res) => {
  if (MAX_PASSES && count() >= MAX_PASSES) return res.status(409).json({ error: 'All passes are booked. Contact the Cultural Committee.' });
  const name = clean(req.body.name, 60), phone = clean(req.body.phone, 10), email = clean(req.body.email, 80);
  const type = req.body.type === 'outsider' ? 'outsider' : 'insider', detail = clean(req.body.detail, 80);
  if (name.length < 3 || !/^\d{10}$/.test(phone) || !detail) return res.status(400).json({ error: 'Enter a valid name, 10-digit mobile number, and details.' });
  if (db.prepare('SELECT 1 FROM regs WHERE phone=?').get(phone)) return res.status(409).json({ error: 'This mobile number is already registered. Use "Find my pass".' });
  for (let i = 0; i < 10; i++) {
    const passNo = 'RC-' + crypto.randomInt(10000, 100000);
    try {
      db.prepare('INSERT INTO regs(passNo,name,phone,email,type,detail,amount) VALUES(?,?,?,?,?,?,?)').run(passNo, name, phone, email, type, detail, FEE[type]);
      return res.json(publicView(db.prepare('SELECT * FROM regs WHERE passNo=?').get(passNo)));
    } catch (e) { if (!/UNIQUE/.test(e.message)) break; }
  }
  res.status(500).json({ error: 'Could not register. Try again.' });
});

app.post('/api/utr', (req, res) => {
  const utr = clean(req.body.utr, 30);
  if (utr.length < 6) return res.status(400).json({ error: 'Enter the full UPI transaction ID.' });
  const r = db.prepare("UPDATE regs SET utr=? WHERE passNo=? AND phone=? AND status!='paid'").run(utr, clean(req.body.passNo, 12).toUpperCase(), clean(req.body.phone, 10));
  r.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Pass not found.' });
});

app.get('/api/pass', (req, res) => {
  const r = db.prepare('SELECT * FROM regs WHERE passNo=? AND phone=?').get(clean(req.query.passNo, 12).toUpperCase(), clean(req.query.phone, 10));
  r ? res.json(publicView(r)) : res.status(404).json({ error: 'No pass found. Check the pass number and mobile number.' });
});

/* ---------- Admin (committee, password) ---------- */
app.use('/api/admin', (req, res, next) => {
  crypto.timingSafeEqual(sha(req.get('x-admin-key') || ''), sha(ADMIN_PASSWORD)) ? next() : res.status(401).json({ error: 'Wrong password.' });
});
app.get('/api/admin/regs', (req, res) => res.json(db.prepare('SELECT * FROM regs ORDER BY id DESC').all()));
app.post('/api/admin/:id/pay', (req, res) => { db.prepare("UPDATE regs SET status='paid' WHERE id=?").run(req.params.id); res.json({ ok: true }); });
app.post('/api/admin/:id/checkin', (req, res) => { db.prepare('UPDATE regs SET checkedIn = 1 - checkedIn WHERE id=?').run(req.params.id); res.json({ ok: true }); });
app.delete('/api/admin/:id', (req, res) => { db.prepare('DELETE FROM regs WHERE id=?').run(req.params.id); res.json({ ok: true }); });
app.get('/api/admin/export', (req, res) => {
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = db.prepare('SELECT * FROM regs ORDER BY id').all();
  res.type('text/csv; charset=utf-8').send('\ufeff' + ['passNo,name,phone,email,type,detail,amount,status,checkedIn'].concat(
    rows.map(r => [r.passNo, r.name, r.phone, r.email, r.type, r.detail, r.amount, r.status, r.checkedIn].map(q).join(','))).join('\n'));
});

app.listen(PORT, () => console.log('Dandiya Night site running on http://localhost:' + PORT));

