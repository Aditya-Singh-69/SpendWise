// SpendWise 2.0 - backend (Express) + hosted PostgreSQL + analysis/forecast API
const express = require('express');
const { Pool, types } = require('pg');
const crypto = require('crypto');
const path = require('path');

types.setTypeParser(1700, parseFloat);   // NUMERIC -> number
types.setTypeParser(20, Number);         // BIGINT  -> number

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });
const q = (text, params) => pool.query(text, params);

/* ---------- DATABASE SCHEMA (created automatically on start) ---------- */
async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS students (
    id         TEXT PRIMARY KEY,
    name       TEXT,
    created_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS transactions (
    id              BIGSERIAL PRIMARY KEY,
    student_id      TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    category        TEXT NOT NULL,
    need_want       TEXT NOT NULL CHECK (need_want IN ('Need','Want')),
    planned_impulse TEXT NOT NULL CHECK (planned_impulse IN ('Planned','Impulse')),
    trigger_type    TEXT NOT NULL DEFAULT 'None',
    spent_at        TEXT NOT NULL)`);   // spent_at is local time 'YYYY-MM-DDTHH:mm'
  await q('CREATE INDEX IF NOT EXISTS idx_tx_student_time ON transactions(student_id, spent_at)');
}

const CATEGORIES = ['Food & drinks','Transport','Education','Entertainment','Shopping','Subscriptions','Health','Other'];
const TRIGGERS = ['None','Hunger','Boredom','Stress','Friends/peer','Offer/discount','Social media/ad','Habit'];

/* ---------- ANALYSIS HELPERS ---------- */
const r2 = n => Math.round(n * 100) / 100;
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const dow = d => new Date(d + 'T00:00:00Z').getUTCDay();
const groupSum = (rows, fn) => rows.reduce((o, r) => { const k = fn(r); o[k] = r2((o[k] || 0) + r.amount); return o; }, {});
const top = o => Object.entries(o).sort((a, b) => b[1] - a[1])[0];
const bucket = h => h >= 5 && h < 12 ? 'Morning' : h < 17 && h >= 12 ? 'Afternoon' : h >= 17 && h < 21 ? 'Evening' : 'Night';

function dailySeries(rows) {
  const byDay = groupSum(rows, r => r.spent_at.slice(0, 10));
  const start = rows[0].spent_at.slice(0, 10);
  const end = rows[rows.length - 1].spent_at.slice(0, 10);
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push({ date: d, amount: byDay[d] || 0 });
  return out;
}

// Forecast = exponentially weighted level x weekday pattern (shrunk toward 1 when data is thin)
function forecast(daily, horizon = 30) {
  const n = daily.length;
  if (n < 7) return null;
  let level = daily[0].amount;
  daily.forEach(d => { level = 0.3 * d.amount + 0.7 * level; });
  const mean = daily.reduce((s, d) => s + d.amount, 0) / n;
  const sd = Math.sqrt(daily.reduce((s, d) => s + (d.amount - mean) ** 2, 0) / n);
  const sum = Array(7).fill(0), cnt = Array(7).fill(0);
  daily.forEach(d => { sum[dow(d.date)] += d.amount; cnt[dow(d.date)]++; });
  const shrink = Math.min(1, n / 28);
  const idx = sum.map((s, w) => (cnt[w] && mean ? (s / cnt[w]) / mean : 1)).map(i => 1 + (i - 1) * shrink);
  const last = daily[n - 1].date;
  const days = Array.from({ length: horizon }, (_, i) => {
    const date = addDays(last, i + 1);
    return { date, amount: r2(Math.max(0, level * idx[dow(date)])) };
  });
  const sumOf = k => r2(days.slice(0, k).reduce((s, d) => s + d.amount, 0));
  const band = k => r2(sd * Math.sqrt(k));
  return { days, next7: sumOf(7), next30: sumOf(30), band7: band(7), band30: band(30), confidence: n >= 28 ? 'good' : n >= 14 ? 'moderate' : 'low' };
}

function analyse(rows) {
  const total = r2(rows.reduce((s, r) => s + r.amount, 0));
  const daily = dailySeries(rows);
  const nDays = daily.length;
  const byCategory = groupSum(rows, r => r.category);
  const byNeedWant = groupSum(rows, r => r.need_want);
  const byPlan = groupSum(rows, r => r.planned_impulse);
  const byTime = groupSum(rows, r => bucket(+r.spent_at.slice(11, 13)));
  const impulse = rows.filter(r => r.planned_impulse === 'Impulse');
  const byTrigger = groupSum(impulse, r => r.trigger_type);
  const avoidable = r2(rows.filter(r => r.planned_impulse === 'Impulse' && r.need_want === 'Want').reduce((s, r) => s + r.amount, 0));
  const weekend = rows.filter(r => [0, 6].includes(dow(r.spent_at.slice(0, 10))));
  const wkndPerDay = weekend.reduce((s, r) => s + r.amount, 0) / Math.max(1, daily.filter(d => [0, 6].includes(dow(d.date))).length);
  const wkdyPerDay = (total - weekend.reduce((s, r) => s + r.amount, 0)) / Math.max(1, daily.filter(d => ![0, 6].includes(dow(d.date))).length);
  const small = rows.filter(r => r.amount <= 150 && r.category === 'Food & drinks');
  const smallMonthly = r2(small.reduce((s, r) => s + r.amount, 0) / nDays * 30);
  const l7 = daily.slice(-7).reduce((s, d) => s + d.amount, 0);
  const p7 = daily.slice(-14, -7).reduce((s, d) => s + d.amount, 0);

  const pct = v => total ? Math.round((v / total) * 100) : 0;
  const impulsePct = pct(byPlan.Impulse || 0), wantPct = pct(byNeedWant.Want || 0);
  const insights = [];
  const add = (title, text, tip) => insights.push({ title, text, tip });

  if (nDays < 7) add('Keep logging', `You have ${nDays} day(s) of data. Log at least 7 days to unlock forecasts and reliable patterns.`, 'Log right after each purchase, or at a fixed time every night.');
  if (impulsePct > 30) add('Unplanned spending is high', `${impulsePct}% of your spending (₹${byPlan.Impulse}) was impulse.`, 'Use a 24-hour rule: wait a day before any non-essential purchase above ₹300.');
  const [topCat, topCatAmt] = top(byCategory);
  if (pct(topCatAmt) > 40) add(`Most money goes to ${topCat}`, `${topCat} is ${pct(topCatAmt)}% of your spending.`, `Set a weekly cap for ${topCat} and review it every Sunday.`);
  if (wantPct > 50) add('Wants outweigh needs', `Wants are ${wantPct}% of your spending.`, 'Try a 50/30/20 split (needs/wants/savings) as a reference, adapted to your allowance.');
  if (impulse.length && (byTime.Night || 0) + (byTime.Evening || 0) > 0) {
    const late = impulse.filter(r => ['Evening', 'Night'].includes(bucket(+r.spent_at.slice(11, 13)))).reduce((s, r) => s + r.amount, 0);
    const imp = impulse.reduce((s, r) => s + r.amount, 0);
    if (imp && late / imp > 0.5) add('Impulse buys cluster after 5 pm', `${Math.round(late / imp * 100)}% of impulse spend happens in the evening or at night.`, 'Remove saved cards from apps and add a pause before ordering at night.');
  }
  if (impulse.length) {
    const [tg] = top(byTrigger);
    if (tg === 'Offer/discount') add('Discounts are your main trigger', 'Most impulse spend follows an offer or discount.', 'Ask: "Would I buy this at full price?"');
    if (['Boredom', 'Stress'].includes(tg)) add('Emotion-linked spending', `${tg} is your top impulse trigger.`, 'Plan a free replacement activity: a walk, a call, a workout.');
    if (['Social media/ad', 'Friends/peer'].includes(tg)) add('Outside influence drives impulse buys', `${tg} is your top impulse trigger.`, 'Unfollow shopping pages; agree a spending limit before going out.');
  }
  if (wkndPerDay > wkdyPerDay * 1.5 && wkndPerDay > 0) add('Weekends drive spending', `You spend about ₹${Math.round(wkndPerDay)}/day on weekends vs ₹${Math.round(wkdyPerDay)} on weekdays.`, 'Set a weekend budget on Friday and withdraw only that amount.');
  if (small.length >= 5) add('Small purchases add up', `Food & drink buys of ₹150 or less project to about ₹${smallMonthly} a month.`, 'Pick two days a week to carry food or a bottle from home.');
  if (p7 > 0 && l7 > p7 * 1.25) add('Spending rose this week', `Last 7 days: ₹${r2(l7)} vs ₹${r2(p7)} the week before.`, 'Check which category jumped and set a limit for it.');
  if (!insights.length) add('Balanced pattern', 'No major risk pattern found in your data so far.', 'Keep logging and try to save a fixed amount every week.');

  const fc = forecast(daily);
  return {
    summary: { total, days: nDays, perDay: r2(total / nDays), count: rows.length, impulsePct, wantPct,
      avoidable, savingIfHalf: r2(avoidable / 2), avoidableMonthlyHalf: r2((avoidable / nDays) * 30 / 2) },
    breakdown: { byCategory, byNeedWant, byPlan, byTime, byTrigger },
    daily, forecast: fc, insights,
    disclaimer: 'Educational insights and estimates, not financial advice.'
  };
}

/* ---------- API ---------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

app.post('/api/students', wrap(async (req, res) => {          // create student with unique ID
  const name = String((req.body || {}).name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Please enter your name' });
  for (let i = 0; i < 5; i++) {
    const id = 'SW-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const r = await q('INSERT INTO students (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, name]);
    if (r.rowCount) return res.status(201).json({ id, name });
  }
  res.status(500).json({ error: 'Could not create ID' });
}));

app.param('id', async (req, res, next, id) => {
  try {
    req.sid = String(id).trim().toUpperCase();
    const r = await q('SELECT 1 FROM students WHERE id = $1', [req.sid]);
    r.rowCount ? next() : res.status(404).json({ error: 'Unknown student ID' });
  } catch (e) { next(e); }
});

app.get('/api/students/:id', wrap(async (req, res) =>
  res.json((await q('SELECT id, name FROM students WHERE id = $1', [req.sid])).rows[0])));

app.post('/api/students/:id/transactions', wrap(async (req, res) => {
  const { amount, category, need_want, planned_impulse, trigger_type = 'None', spent_at } = req.body || {};
  const amt = Number(amount);
  if (!(amt > 0) || amt > 1e6) return res.status(400).json({ error: 'Enter a valid amount' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  if (!['Need', 'Want'].includes(need_want)) return res.status(400).json({ error: 'Choose Need or Want' });
  if (!['Planned', 'Impulse'].includes(planned_impulse)) return res.status(400).json({ error: 'Choose Planned or Impulse' });
  if (!TRIGGERS.includes(trigger_type)) return res.status(400).json({ error: 'Invalid trigger' });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(spent_at || '')) return res.status(400).json({ error: 'Invalid date/time' });
  const r = await q(`INSERT INTO transactions (student_id, amount, category, need_want, planned_impulse, trigger_type, spent_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [req.sid, amt, category, need_want, planned_impulse, trigger_type, spent_at.slice(0, 16)]);
  res.status(201).json({ id: r.rows[0].id });
}));

app.get('/api/students/:id/transactions', wrap(async (req, res) =>
  res.json((await q('SELECT * FROM transactions WHERE student_id = $1 ORDER BY spent_at DESC LIMIT 50', [req.sid])).rows)));

app.delete('/api/students/:id/transactions/:tx', wrap(async (req, res) => {
  if (!/^\d+$/.test(req.params.tx)) return res.status(400).json({ error: 'Invalid purchase' });
  await q('DELETE FROM transactions WHERE id = $1 AND student_id = $2', [req.params.tx, req.sid]);
  res.json({ ok: true });
}));

app.get('/api/students/:id/analysis', wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM transactions WHERE student_id = $1 ORDER BY spent_at ASC', [req.sid]);
  if (!rows.length) return res.json({ empty: true });
  res.json(analyse(rows));
}));

app.get('/api/meta', (req, res) => res.json({ CATEGORIES, TRIGGERS }));

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error. Please try again.' }); });

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`SpendWise running at http://localhost:${PORT}`)))
  .catch(e => { console.error('Database connection failed:', e.message); process.exit(1); });
