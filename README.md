# Tasker

**v1.9.2** — An anonymous task-logging PWA for healthcare staff. Built with TypeScript, Express 5, SQLite, and vanilla JS.

---

## Features

- **Anonymous by design** — usernames are auto-generated memorable word pairs. No real names, emails, or patient data stored.
- **PWA** — installable on mobile, works offline for cached assets.
- **Task tracking** — duty vs personal tasks, categories, subcategories, outcomes, interruption handling.
- **Task flags** — admin-managed list of structured task annotations (e.g. "Sent to wrong user", "Priority too high"). Users select any that apply; free-text notes removed for data protection. Users can suggest new flags via email.
- **Analytics** — session and 30-day history with Chart.js charts, filtering, flag distribution chart, linear regression trendlines, and XLSX analytics report download.
- **Excel export** — users can download their raw task data as `.xlsx` (includes Flags column), or download a full analytics report as `.xlsx` with one data sheet per chart.
- **User groups** — administrators create groups that define which dropdown options users see.
- **Personal option customisation** — users can tick/untick individual options to build their own personalised dropdown lists.
- **SMTP email suggestions** — dropdown and flag suggestions are emailed to the administrator instead of being stored on the server, improving data security. Configure via admin panel or environment variables.
- **Notices** — administrators can post notices that appear on every user's home screen.
- **User messages** — administrators can send messages to individual users or broadcast to all users; messages appear on the user's home screen and are dismissable.
- **Integrated combobox dropdowns** — all task dropdowns are searchable comboboxes.
- **Admin panel** — user management, DB backup/restore, dropdown configuration, SMTP settings, notices management, task flag options, registration settings, group management, pending proposals. Desktop-optimised layout.
- **Configurable registration** — administrator controls three levels for self-registration and user invitations.
- **30-day data retention** — task data is automatically deleted after 30 days.
- **Health-check endpoint** — `GET /readyz` returns a JSON status response for uptime/heartbeat monitoring.
- **Asset version endpoint** — `GET /api/version` returns `{"version":"1.9.2"}` for client-side cache-busting.

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

### v1.9.1 (April 2026)

- **Analytics XLSX report** — Replaced the "Print / Save as PDF" button in the analytics section with a "Download Analytics (.xlsx)" button. Clicking it downloads `Tasker-Analytics-YYYYMMDDHHmm.xlsx` — a multi-sheet workbook with one data table sheet per chart, mirroring all graphical output: Summary, Time by Category, Duty vs Personal, Outcome Distribution, Outcome by Category, Avg Duration (Category), Tasks by Type, Avg Duration (Task Type), Task Types by Source Group, Flag Distribution, Flags by Source Group, Activity by Hour, Activity by Day of Week, Task Types by Day Assigned, Personal by Day (Origin), Personal by Day (Type), Tasks Over Time (with optional regression trend column), Interruptions Over Time, and Assignment Lag. Sheets are only included when the corresponding chart would be visible. Served by a new `GET /api/analytics/report` endpoint that accepts the same filter parameters as the history view.
- **Version bump** — Version number incremented to 1.9.1; all page footers and documentation updated accordingly.

### v1.9.0 (April 2026)

- **Version bump** — Version number incremented to 1.9.0; all page footers and documentation updated accordingly.

### v1.8.6 (April 2026)

- **Suggestion safety notice** — The "Send suggestion to developers" input now displays a prominent warning instructing users not to submit any patient, location, or staff-identifiable information. The notice also clarifies that submitted freetext is sent to an NHS.net email address and invites users to include their own email address if they wish to receive a reply.
- **Documentation updates** — help.html, guide.html, dpia.html, technical-manual.html, installation.md, and maintenance.md updated to document the suggestion feature data flow and acceptable-use requirements.

### v1.8.1 (April 2026)

- **SMTP email configuration** — Added SMTP settings section in the admin panel. Dropdown and flag suggestions from users are now emailed to the administrator instead of being stored on the server. This removes free-text personal data from the database in line with data protection principles. Supports STARTTLS (port 587) and SSL/TLS (port 465). SMTP password is encrypted at rest using AES-256-GCM.
- **Task flags replace free-text notes** — The free-text "Notes" field has been removed from task review. Instead, users select from an admin-managed list of structured flag options (e.g. "Sent to wrong user", "Priority too high"). Multiple flags can be applied per task. Flags are stored per-task in a dedicated `task_flags` table.
- **User-suggestable flags** — Users can suggest new flag options from the task review screen. Suggestions are sent by email to the administrator and never stored on the server.
- **Notices** — Administrators can create, edit, activate/deactivate, and delete notices that appear prominently on every user's home screen.
- **User messages** — Administrators can send messages to individual users or broadcast to all active users. Messages appear on the user's home screen with individual dismiss controls.
- **Auto-notification on dropdown approval** — When an admin adds a new dropdown option for a field, users who had pending email proposals for that field automatically receive a user message confirming the update.
- **Analytics updates** — New "Flagged tasks" stat card; new "Task Flag Distribution" bar chart; flag labels shown on individual task cards; export includes `Flags` column instead of `Notes`.
- **Default flag options** — Five default task flag options are seeded on first run: "Sent to wrong user", "Priority too high", "Priority too low", "Should be sent to group", "Should be sent to specific user".
- **Dependency** — Added `nodemailer@8.0.5`.

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

