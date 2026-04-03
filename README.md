# Tasker

An anonymous, mobile-only task-logging PWA for healthcare staff. Built with TypeScript, Express 5, SQLite3, and vanilla JS.

---

## Features

- **Anonymous by design** — usernames are auto-generated memorable word pairs (e.g. `CalmRiver`). No real names, emails, or patient data stored.
- **Mobile-only** — desktop browsers are blocked. Access from NHS networks is blocked.
- **PWA** — installable on mobile, works offline for cached assets.
- **Task tracking** — duty vs personal tasks, categories, subcategories, outcomes, interruption handling.
- **Analytics** — session and 30-day history with Chart.js charts, filtering, and linear regression trendlines.
- **Excel export** — users can download their own data as `.xlsx` (mobile only).
- **Admin panel** — user management (counts only, no data access), DB backup/restore, dropdown configuration.
- **30-day data retention** — task data is automatically deleted after 30 days.

---

## Requirements

- Node.js ≥ 20 (built and tested on Node 24)
- npm ≥ 9

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Build TypeScript
npm run build

# 3. Start the server
SESSION_SECRET=your_long_random_secret_here node dist/server.js
```

Server runs on port 3000 by default. Set `PORT` to override.

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `3000` |
| `SESSION_SECRET` | Session signing secret (**set this in production!**) | Random (changes on restart) |
| `NODE_ENV` | Set to `production` to enable secure cookies (requires HTTPS) | — |

**⚠️ In production, always set `SESSION_SECRET` to a long random string and serve over HTTPS.**

---

## Create the Admin Account

After first start, run this once to create the admin user:

```bash
node -e "
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const db = new Database('data/tasker.db');
const hash = bcrypt.hashSync('Admin123!', 12);
db.prepare('INSERT OR IGNORE INTO users (username, password_hash, is_admin, must_change_password) VALUES (?, ?, 1, 1)').run('admin', hash);
console.log('Admin created — username: admin, temp password: Admin123!');
db.close();
"
```

Log in at `/` on a mobile device with username `admin` and password `Admin123!`. You will be forced to change the password immediately.

---

## Production Deployment

1. Set up a reverse proxy (Nginx or Caddy) with HTTPS/TLS.
2. Set `NODE_ENV=production` and `SESSION_SECRET` environment variables.
3. Run `node dist/server.js` via `pm2` or a systemd service.
4. SQLite database stored in `data/tasker.db`.

**Example systemd service:**

```ini
[Unit]
Description=Tasker
After=network.target

[Service]
WorkingDirectory=/opt/tasker
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
Environment=NODE_ENV=production
Environment=SESSION_SECRET=<long random string here>
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

---

## Development

```bash
npm run dev   # ts-node src/server.ts
npm run build # compile TypeScript → dist/
```

---

## Architecture

```
src/
  server.ts               Express 5 app, middleware wiring, 30-day retention job
  db.ts                   SQLite schema + seed data, getDb(), replaceDb()
  words.ts                Memorable two-word username generator
  middleware/index.ts     NHS block, mobile-only, requireAuth, requireAdmin, CSRF, logEvent
  routes/
    auth.ts               /api/auth/* — register, login, logout, change-password, me
    tasks.ts              /api/tasks/* — start, active, PATCH, GET
    analytics.ts          /api/analytics/* — session, history, export (xlsx)
    dropdowns.ts          /api/dropdowns/* — list, propose, admin CRUD
    admin.ts              /api/admin/* — stats, users, backup, restore

public/
  index.html              SPA shell
  manifest.json           PWA manifest
  sw.js                   Service worker (cache-first static, network-first API)
  policy.html             Data & Use Policy
  css/app.css             Mobile-first styles (no horizontal scroll, 44px+ touch targets)
  js/app.js               Complete SPA — 13 views, Chart.js charts, regression trendlines
```

---

## Security

- CSRF tokens on all mutating requests (`X-CSRF-Token` header)
- Rate limiting: auth 20/15 min, API 200/min
- bcrypt cost factor 12 for passwords
- HTTP-only, SameSite=strict session cookies
- Helmet.js security headers
- NHS network IP range blocking (HSCN/N3)
- Parameterised SQL queries throughout — no string concatenation
- 30-minute idle session timeout + midnight session expiry
- No patient data stored (enforced by schema design and UI warnings)
- Path validation on DB restore endpoint

---

## Data & Use Policy

See [`/policy`](/policy) for the full Data and Use Policy covering:
- What is stored (anonymous username, hashed password, task metadata)
- What is **never** stored (names, emails, patient identifiers)
- 30-day automatic data retention
- Who can access what
- User responsibilities (never enter patient data)
