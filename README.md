# Tasker

**v1.7.1** — An anonymous task-logging PWA for healthcare staff. Built with TypeScript, Express 5, SQLite, and vanilla JS.

---

## Features

- **Anonymous by design** — usernames are auto-generated memorable word pairs. No real names, emails, or patient data stored.
- **PWA** — installable on mobile, works offline for cached assets.
- **Task tracking** — duty vs personal tasks, categories, subcategories, outcomes, interruption handling.
- **Analytics** — session and 30-day history with Chart.js charts, filtering, and linear regression trendlines.
- **Excel export** — users can download their own data as `.xlsx`.
- **User groups** — administrators create groups that define which dropdown options users see. Users select their group on first login and can suggest new groups for administrator review.
- **Personal option customisation** — after selecting a group, users can tick/untick individual options to build their own personalised dropdown lists. Accessible at any time from Settings.
- **Integrated combobox dropdowns** — all task dropdowns are searchable comboboxes: type to filter, click or press Enter to select, suggest new options inline.
- **Admin panel** — user management (counts only, no data access), DB backup/restore, dropdown configuration, registration settings, group management, pending group/option proposal review. Desktop-optimised layout (max 900 px, multi-column).
- **Configurable registration** — administrator controls three levels for self-registration and user invitations: disabled, administrator-approved (default), or automatic approval.
- **User invitations** — logged-in users can invite others using the same temp-password flow as admins (subject to the configured policy).
- **30-day data retention** — task data is automatically deleted after 30 days.
- **Health-check endpoint** — `GET /readyz` returns a JSON status response for uptime/heartbeat monitoring (no authentication required).
- **Asset version endpoint** — `GET /api/version` returns `{"version":"1.7.1"}` for client-side cache-busting.

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
  server.ts               Express 5 app, middleware wiring, SSL detection, 30-day retention job, /readyz health check, /api/version endpoint
  db.ts                   SQLite schema + migrations + seed data, getDb(), getSetting(), setSetting(), TASKER_DB_PATH override for tests
  words.ts                Memorable two-word username generator
  middleware/index.ts     requireAuth, requireAdmin, CSRF, logEvent
  routes/
    auth.ts               /api/auth/* — register, login, logout, change-password, me, account delete, invite, user-groups, set-group, propose-group, my-options
    tasks.ts              /api/tasks/* — start, active, PATCH, GET
    analytics.ts          /api/analytics/* — session, history, export (xlsx)
    dropdowns.ts          /api/dropdowns/* — list, propose, admin CRUD
    admin.ts              /api/admin/* — stats, users, pending-users, approve, settings, backup, restore, user-groups, pending-groups

  __tests__/
    security.test.ts      52-test negative security suite (CSRF, IDOR, SQLi, XSS, input validation, resource exhaustion, error handling)
    helpers/testApp.ts    Isolated Express app + test-user helpers for jest/supertest

public/
  index.html              SPA shell
  favicon.svg             SVG favicon (browser tab icon)
  manifest.json           PWA manifest
  sw.js                   Service worker (cache-first static, network-first API)
  policy.html             Data & Use Policy  (served at /policy)
  help.html               User guide         (served at /help)
  css/app.css             Mobile-first styles
  js/app.js               Complete SPA — views, Chart.js charts, regression trendlines, browser history navigation, asset version checking, integrated combobox dropdowns
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
- Parameterised SQL queries throughout
- Path validation on DB restore endpoint
- Automatic HTTPS when certificates are present
- `/readyz` health-check endpoint is unauthenticated but returns no sensitive data
- `safeId()` helper sanitises combobox container IDs before insertion into inline event handlers
- 52-test negative security suite covering CSRF, IDOR, SQL injection, XSS, input validation, resource exhaustion, and error handling (`npm test`)

---

## Data & Use Policy

See [`/policy`](/policy) for the full Data and Use Policy.

---

## Changelog

### v1.7.1 (April 2026)

- **Policy update** — Removed restriction on use over NHS networks or NHS Wi-Fi. The application may now be accessed from any network. Updated Data and Use Policy, DPIA, and all supporting documentation accordingly.

### v1.5.0 (April 2026)

- **User groups** — administrators create named groups that control which dropdown options users see. Each group has an independent option set configurable from the admin panel.
- **Personal option customisation** — after selecting a group, users are presented with a ⚙️ Customise My Options screen showing all group defaults as tick-boxes. Users can untick options they never use; their choices are stored per-account and override group defaults in all task forms. The screen is accessible at any time from ⚙️ Settings.
- **Group proposals** — users can suggest new group names from the group-selection screen. Proposals appear in a new **Pending Group Proposals** section of the Admin Panel for administrator approval or rejection.
- **Option proposals** — users can suggest new dropdown values (Task From, Task Type, Outcome) inline from the Customise My Options screen. Proposals appear in the existing Pending User Proposals section.
- **Integrated combobox dropdowns** — all task-form dropdowns (Task From, Task Type, Outcome) are now fully searchable comboboxes. Clicking opens a panel; typing filters options instantly; arrow keys navigate; Enter selects; Escape closes. No separate search boxes.
- **Admin desktop layout** — the admin panel is now wider (max-width 900 px) on desktop with Users/User Groups in a two-column grid and Dropdown Options shown three-across.
- **Modal positioning fix** — option and group modals are now centred in the viewport on screens ≥640 px with action buttons pinned to the bottom of the dialog.
- **Security hardening** — `POST /api/auth/set-group` now enforces `is_approved=1`, preventing users from joining a pending/unapproved group. A `safeId()` helper strips non-identifier characters from combobox IDs before insertion into inline HTML event handlers.
- **Security test suite** — 52 negative tests (`src/__tests__/security.test.ts`, run with `npm test`) covering CSRF, authentication, IDOR, SQL injection, XSS, input validation, resource exhaustion, error handling, temporal consistency, path traversal, and group access control.
- **`TASKER_DB_PATH` env var** — allows test isolation by pointing the DB singleton at an in-process temp file.

### v1.4.0 (April 2026)

- **SPA back/forward navigation** — browser Back and Forward buttons now work correctly throughout the app. Every view transition records itself in the browser history stack (`history.pushState`); a `popstate` listener dispatches navigation events back to the correct render function with an auth guard.
- **Asset version-gate reload** — on startup the app fetches `/api/version` (network-first, bypassing the service worker cache) and compares it to the version stored in `localStorage`. On a mismatch all service worker caches are cleared, the service worker is unregistered, and the page reloads to guarantee fresh `app.js`, `app.css`, and `index.html` are loaded.
- **`GET /api/version`** — new lightweight endpoint returning `{ "version": "1.4.0" }`, rate-limited.

### v1.2.0 (April 2026)

- **Health-check endpoint** — `GET /readyz` returns `{"ok":true,"service":"Tasker","version":"1.2.0","timestamp":"..."}` for uptime/heartbeat polling servers. No authentication required.
- **Login error messages** — failed login attempts (wrong username or password) now display the server's friendly error message in the login form instead of silently resetting the form.

### v1.1.0

- Initial public release with task logging, analytics, admin panel, Excel export, PWA support, and configurable registration.

