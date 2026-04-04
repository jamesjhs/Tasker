# Tasker

**v1.2.0** — An anonymous, mobile-only task-logging PWA for healthcare staff. Built with TypeScript, Express 5, SQLite, and vanilla JS.

---

## Features

- **Anonymous by design** — usernames are auto-generated memorable word pairs. No real names, emails, or patient data stored.
- **Mobile-only** — desktop browsers are blocked. Access from NHS networks is blocked.
- **PWA** — installable on mobile, works offline for cached assets.
- **Task tracking** — duty vs personal tasks, categories, subcategories, outcomes, interruption handling.
- **Analytics** — session and 30-day history with Chart.js charts, filtering, and linear regression trendlines.
- **Excel export** — users can download their own data as `.xlsx`.
- **Admin panel** — user management (counts only, no data access), DB backup/restore, dropdown configuration, and registration settings.
- **Configurable registration** — administrator controls three levels for self-registration and user invitations: disabled, administrator-approved (default), or automatic approval.
- **User invitations** — logged-in users can invite others using the same temp-password flow as admins (subject to the configured policy).
- **30-day data retention** — task data is automatically deleted after 30 days.
- **Health-check endpoint** — `GET /readyz` returns a JSON status response for uptime/heartbeat monitoring (no authentication required).

---

## Documentation

| Document | Location |
|---|---|
| Installation guide | [`docs/installation.md`](docs/installation.md) |
| Maintenance & troubleshooting | [`docs/maintenance.md`](docs/maintenance.md) |
| User guide (in-app) | `/help` route |
| Data & Use Policy (in-app) | `/policy` route |

---

## Quick start (development)

```bash
# 1. Install dependencies
npm install

# 2. Build TypeScript
npm run build

# 3. Copy and configure environment
cp .env.example .env

# 4. Start the server
node dist/server.js
```

Server runs on port **3020** by default (set `PORT` in `.env` to override).

Then create the admin account — see [Installation guide](docs/installation.md#first-run-and-admin-account-creation).

---

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `3020` |
| `SESSION_SECRET` | Session signing secret (**set this in production!**) | Random (changes on restart) |
| `NODE_ENV` | Set to `production` to enable secure cookies (requires HTTPS) | — |
| `SSL_CERT_DIR` | Directory containing Let's Encrypt certificate files | `/etc/letsencrypt/live/yourdomain` |
| `SSL_CERT` | Path to the certificate chain (auto-detects HTTPS if this file exists) | `$SSL_CERT_DIR/fullchain.pem` |
| `SSL_KEY` | Path to the private key | `$SSL_CERT_DIR/privkey.pem` |

> **HTTPS is detected automatically.** If both `SSL_CERT` and `SSL_KEY` exist on disk the server starts in HTTPS mode. Otherwise it starts in plain HTTP mode.

> ⚠️ **In production, always set `SESSION_SECRET` to a long random string and serve over HTTPS.**

---

## Development

```bash
npm run dev   # ts-node src/server.ts  (no build step required)
npm run build # compile TypeScript → dist/
```

---

## Architecture

```
src/
  server.ts               Express 5 app, middleware wiring, SSL detection, 30-day retention job, /readyz health check
  db.ts                   SQLite schema + migrations + seed data, getDb(), getSetting(), setSetting()
  words.ts                Memorable two-word username generator
  middleware/index.ts     NHS block, mobile-only, requireAuth, requireAdmin, CSRF, logEvent
  routes/
    auth.ts               /api/auth/* — register, login, logout, change-password, me, account delete, invite
    tasks.ts              /api/tasks/* — start, active, PATCH, GET
    analytics.ts          /api/analytics/* — session, history, export (xlsx)
    dropdowns.ts          /api/dropdowns/* — list, propose, admin CRUD
    admin.ts              /api/admin/* — stats, users, pending-users, approve, settings, backup, restore

public/
  index.html              SPA shell
  favicon.svg             SVG favicon (browser tab icon)
  manifest.json           PWA manifest
  sw.js                   Service worker (cache-first static, network-first API)
  policy.html             Data & Use Policy  (served at /policy)
  help.html               User guide         (served at /help)
  css/app.css             Mobile-first styles
  js/app.js               Complete SPA — views, Chart.js charts, regression trendlines
  icons/
    icon-192.png          PWA home-screen icon (192×192)
    icon-512.png          PWA splash / store icon (512×512)

docs/
  installation.md         Full installation guide (server, SSL, systemd, Nginx/Caddy)
  maintenance.md          Routine maintenance, backup/restore, troubleshooting
```

---

## Security

- CSRF tokens on all mutating requests (`X-CSRF-Token` header)
- Rate limiting: auth 20/15 min, API 200/min
- bcrypt cost factor 12 for passwords
- Account lockout after repeated failed login attempts
- Friendly error messages on failed login (username/password invalid)
- HTTP-only, SameSite=strict session cookies
- 30-minute idle session timeout + midnight session expiry
- Helmet.js security headers
- NHS network IP range blocking (HSCN/N3)
- Parameterised SQL queries throughout
- Path validation on DB restore endpoint
- Automatic HTTPS when certificates are present
- `/readyz` health-check endpoint is unauthenticated but returns no sensitive data

---

## Data & Use Policy

See [`/policy`](/policy) for the full Data and Use Policy.

---

## Changelog

### v1.2.0 (April 2026)

- **Health-check endpoint** — `GET /readyz` returns `{"ok":true,"service":"Tasker","version":"1.2.0","timestamp":"..."}` for uptime/heartbeat polling servers. No authentication required; exempt from mobile-only restriction.
- **Login error messages** — failed login attempts (wrong username or password) now display the server's friendly error message in the login form instead of silently resetting the form.

### v1.1.0

- Initial public release with task logging, analytics, admin panel, Excel export, PWA support, and configurable registration.

