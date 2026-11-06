# SpendWise 2.0

**From "Where did my money go?" to "Why did I spend it?"**

SpendWise is a student-focused behavioural spending analytics web app. Students log purchases in about 20 seconds, then get plain-language insights about their patterns, a view of their impulse spending, and a forecast of the weeks ahead, all based on their own history.

It is built as the working prototype for an individual MBA experiential project: a small, privacy-conscious pilot that tests whether behavioural feedback can improve students' financial awareness and responsible spending.

> Educational insights only. SpendWise does not give investment, lending, tax or other regulated financial advice.

---

## Features

- **Quick logging:** amount, category, need or want, planned or impulse, optional trigger, and a date and time entered as `DD/MM/YYYY` and `hh:mm AM/PM`.
- **Unique student ID:** each student gets an ID such as `SW-A1B2C3` and uses it to return to their own dashboard.
- **Personal dashboard:** impulse-share summary, totals, per-day average, category and time-of-day charts, and need/want and planned/impulse splits.
- **Rule-based insights:** each pattern comes with a practical "Try this" tip, plus a "what could have been different" estimate.
- **Spending forecast:** expected spending for the next 7 and 30 days, with a range and a confidence label.
- **Survey integration:** links to the baseline Google Form with the student's ID and name pre-filled.
- **Responsive design:** works on phones, supports light and dark mode, and respects reduced-motion settings.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, vanilla JavaScript, [Chart.js](https://www.chartjs.org/) (CDN), Google Fonts |
| Backend | Node.js 20.6+, [Express](https://expressjs.com/) 4 |
| Database | PostgreSQL (hosted on [Neon](https://neon.tech)), accessed with [`pg`](https://node-postgres.com/) |
| Surveys | Google Forms, Google Apps Script, Google Sheets |
| Hosting | [Render](https://render.com) (web service), GitHub (source) |

No front-end framework, ORM or authentication library is used. See [Limitations](#limitations).

## Project structure

```
spendwise/
├── server.js          # Express API, PostgreSQL access, analysis and forecast engine
├── public/
│   └── index.html     # The whole frontend (HTML, CSS and JavaScript)
├── create_forms.gs    # Google Apps Script that builds the baseline and post-pilot forms
├── migrate.js         # One-time script: copy old SQLite data into PostgreSQL
├── package.json
├── .gitignore
└── README.md
```

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 20.6 or newer (check with `node -v`)
- A PostgreSQL database. A free [Neon](https://neon.tech) project works well.

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/spendwise.git
cd spendwise
npm install
```

### 2. Configure the database

Create a file named `.env` in the project folder:

```
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require
```

Use the connection string from your Neon dashboard (**Connect** button). Never commit this file. It is already listed in `.gitignore`.

### 3. Run it

```bash
npm run dev
```

Open <http://localhost:3000>. The tables are created automatically on first start.

For production use `npm start`, with `DATABASE_URL` set as an environment variable instead of a `.env` file.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | Port to listen on (default `3000`; set automatically by most hosts) |

## API

All routes return JSON. A student ID in the URL is case-insensitive.

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/students` | Create a student. Body: `{ "name": "..." }`. Returns `{ id, name }` |
| `GET` | `/api/students/:id` | Check an ID and return the student's name |
| `POST` | `/api/students/:id/transactions` | Log a purchase |
| `GET` | `/api/students/:id/transactions` | Latest 50 purchases |
| `DELETE` | `/api/students/:id/transactions/:tx` | Delete one purchase |
| `GET` | `/api/students/:id/analysis` | Summary, breakdowns, insights and forecast |
| `GET` | `/api/meta` | Allowed categories and triggers |

Example purchase body:

```json
{
  "amount": 250,
  "category": "Food & drinks",
  "need_want": "Want",
  "planned_impulse": "Impulse",
  "trigger_type": "Boredom",
  "spent_at": "2026-11-05T19:45"
}
```

## Database schema

```sql
students (
  id          TEXT PRIMARY KEY,         -- e.g. SW-A1B2C3
  name        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
)

transactions (
  id               BIGSERIAL PRIMARY KEY,
  student_id       TEXT REFERENCES students(id) ON DELETE CASCADE,
  amount           NUMERIC(12,2) CHECK (amount > 0),
  category         TEXT,
  need_want        TEXT CHECK (need_want IN ('Need','Want')),
  planned_impulse  TEXT CHECK (planned_impulse IN ('Planned','Impulse')),
  trigger_type     TEXT DEFAULT 'None',
  spent_at         TEXT                  -- local time, 'YYYY-MM-DDTHH:mm'
)
```

Deleting a student also deletes their purchases. An optional reporting view that shows each purchase beside the student's name:

```sql
CREATE OR REPLACE VIEW transactions_with_names AS
SELECT s.name, t.student_id, t.id, t.amount, t.category, t.need_want,
       t.planned_impulse, t.trigger_type, t.spent_at
FROM transactions t JOIN students s ON s.id = t.student_id
ORDER BY s.name, t.student_id, t.spent_at;
```

## How the analysis works

All analysis runs in plain JavaScript in `server.js`, with no AI or machine-learning model.

**Insights.** Rules fire when a pattern is found, for example:

- Impulse purchases above 30% of spending
- One category above 40% of spending
- Wants above 50% of spending
- Impulse buying concentrated in the evening or at night
- A dominant impulse trigger (offers, boredom or stress, ads or friends)
- Weekend spending well above weekday spending
- Many small food and drink purchases that add up
- Spending up sharply compared with the previous week

**Forecast.** An exponentially weighted average of daily spending (smoothing factor 0.3), adjusted by a weekday pattern that is blended toward neutral when there is little data. It needs at least 7 days of data. Confidence is labelled *low* (under 14 days), *moderate* (14 to 27 days) or *good* (28 days or more). The shown range is based on the spread of daily spending.

**"What could have been different."** Spend that was both impulse and a want is treated as potentially avoidable, and the app shows what half of it would be as a monthly amount. It is a reflection estimate, not a verdict.

Thresholds and wording are in the `analyse()` function and are easy to tune after user validation.

## Surveys (before/after measurement)

`create_forms.gs` is a Google Apps Script that builds two Google Forms with identical scored questions, so results can be compared:

- **Baseline survey:** consent, participant ID, background, financial awareness, planning and self-control, impulse tendency, spending habits, and open questions.
- **Post-pilot survey:** the same scored sections plus a usefulness section and open feedback.

To use it, open [script.google.com](https://script.google.com), create a project, paste the file, and run `createBaselineForm()` (later `createPostPilotForm()`). Then set the form link and the ID and name entry codes in the `SURVEY_...` constants near the bottom of `public/index.html`. The "Get pre-filled link" option in Google Forms shows the entry codes.

## Deployment

1. Create a Neon database and copy its connection string.
2. Push this repository to GitHub.
3. On Render, create a **Web Service** from the repository:
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variable: `DATABASE_URL`
4. Every `git push` to the main branch redeploys automatically.

Because the data lives in Neon, redeploying does not affect it.

### Migrating from the earlier SQLite version

If you have data from the earlier local version, run the tables once (start the server), then:

```bash
npm i better-sqlite3 --no-save
DATABASE_URL="postgresql://..." node migrate.js spendwise.db
```

Run it only once, because running it again duplicates purchases.

## Privacy and ethics

- No bank, UPI or card details and no passwords are collected.
- Participation is voluntary, with consent captured in the baseline survey.
- Only the data needed for the research question is stored: a name, a participant ID, and the purchases the student chooses to log.
- Data is used only for the academic project, and results are reported in group form.
- Keep the database connection string private. Never commit `.env`.
- If you handle real participants, state in your consent text which data is stored, where, and who can see it.

## Limitations

- **The ID works like a simple access code, not a password.** Anyone who knows an ID can view that student's data. This is acceptable for a small supervised pilot but not for wider release. Add real authentication before scaling.
- Logging is manual, so under-reporting and entry fatigue are possible.
- Forecasts are estimates from very small datasets and should be treated as a guide.
- With a pilot of roughly 5 to 10 students, findings are directional and descriptive, not statistically conclusive.

## Roadmap ideas

- PIN or password protection per student
- Password-protected admin page with CSV export
- Weekly budget and "forecast versus budget" view
- Post-pilot survey button in the dashboard
- Optional AI-written insight summaries from anonymised numbers, with a human-verified decision log

## Project context

SpendWise 2.0 is an individual experiential MBA project with a 15-week pilot. It supports **SDG 4 (Quality Education)** by treating financial literacy as applied learning, and **SDG 12 (Responsible Consumption and Production)** by making discretionary and avoidable spending more visible. Claims are limited to pilot level.

## Author

Aditya Singh