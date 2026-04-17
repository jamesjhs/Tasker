# Tasker — Detailed Application Analysis

> Generated April 2026. Covers repository state at v1.9.1.
> Intended for non-developer stakeholders and external analysis engines.

---

## 1. What is Tasker?

Tasker is a **Progressive Web App (PWA)** — a mobile-first web application installable on any smartphone — that lets healthcare staff anonymously time and categorise the tasks they perform during a working shift. It is a stopwatch-style tool: press **Start**, work, press **End**, pick an outcome. At day's end the user sees charts of where their time went and can download their data as an Excel file.

Key design goal: **no identity, no patient data, ever.** Usernames are randomly generated word-pairs (e.g. *CalmRiver*, *BoldMoss*); no real name, email, or NHS number is ever requested or stored.

---

## 2. Data Model — What is Saved and Where

**Storage location:** A single **SQLite** file at `data/tasker.db` on the server (`src/db.ts`, line 9). Sessions are stored in a separate `data/sessions.db`. There is no cloud service, third-party database, or external storage of any kind.

### Tables and Fields (`src/db.ts`, lines 50–128)

| Table | Fields | Purpose |
|---|---|---|
| **users** | `id`, `username` (word-pair), `password_hash` (bcrypt), `must_change_password`, `is_admin`, `is_approved`, `pending_activation`, `mfa_enabled`*, `failed_login_attempts`, `is_locked`, `user_group_id`, `created_at` | One row per account |
| **tasks** | `id`, `user_id` (FK), `is_duty` (0/1), `assigned_date`, `start_time`, `end_time`, `category`, `subcategory`, `outcome`, `interruptions` (JSON array), `notes` (**encrypted**, see §7), `status` (`in_progress`/`completed`/`discarded`), `created_at`, `updated_at` | One row per logged task |
| **dropdown_options** | `id`, `field_name` (`category`/`subcategory`/`outcome`), `value`, `approved`, `proposed_by_user_id`, `created_at` | Master list of selectable values |
| **user_groups** | `id`, `name`, `created_at`, `is_approved` | Named groups (e.g. "Nursing", "Doctors") |
| **group_dropdown_options** | `group_id`, `dropdown_option_id` | Which dropdown values each group sees |
| **user_dropdown_options** | `user_id`, `dropdown_option_id` | Each user's personalised option selection |
| **settings** | `key`, `value` | App-wide config (`self_registration`, `user_invite`) |
| **events** | `id`, `event_type`, `created_at` | **Anonymous** audit counts only (no user ID attached) |
| **pending_task_logs** | `id`, `user_id`, `count`, `logged_at` | Snapshot counts of pending/queued tasks |

\* `mfa_enabled` column exists in schema but MFA is not yet implemented in routes.

### Task Fields Explained

| Field | Meaning |
|---|---|
| `is_duty` | Whether this was a "My Group" (duty) task (1) or personal (0) |
| `assigned_date` | The calendar date the task was assigned (may differ from today) |
| `start_time` / `end_time` | ISO timestamps of when the user started and stopped the stopwatch |
| `category` ("Task From") | Origin category, e.g. *Clinical*, *Administrative* |
| `subcategory` ("Task Type") | Activity type, e.g. *Direct patient care*, *Referral* |
| `outcome` | What happened, e.g. *Completed*, *Delegated*, *Deferred* |
| `interruptions` | JSON array of `{ start, end }` objects (subtracted from duration) |
| `notes` | Free-text (optional); AES-256-GCM encrypted at rest if `ENCRYPTION_KEY` is set |

### Default Dropdown Values (seeded at first run, `src/db.ts` lines 170–177)

- **Categories:** Clinical, Administrative, Teaching, Research, Management
- **Subcategories:** Direct patient care, Documentation, Communication, Handover, Referral
- **Outcomes:** Completed, Delegated, Escalated, Deferred, Abandoned

---

## 3. Where and How Data is Stored

| Layer | Mechanism |
|---|---|
| **Server-side persistence** | SQLite file `data/tasker.db` (via `better-sqlite3`). WAL journal mode for reliability. `src/db.ts` |
| **Server sessions** | Separate SQLite file `data/sessions.db` via `better-sqlite3-session-store`. `src/server.ts` line 56 |
| **Client-side (browser)** | `localStorage` holds only: `tasker_app_version` (for cache-busting) and `tasker_last_active` (for the 30-min inactivity timer). No task data in `localStorage`. `public/js/app.js` lines 77, 316 |
| **Service Worker cache** | Static assets only (HTML, CSS, JS). API responses are never cached — all API calls go network-first. `public/sw.js` |

### 30-Day Automatic Deletion

A background job runs on startup and every 24 hours. It permanently deletes tasks older than 30 days:

```sql
DELETE FROM tasks WHERE created_at < datetime('now', '-30 days')
```

Source: `src/server.ts`, lines 126–132. This is irreversible.

---

## 4. Network Calls / APIs

All calls are **same-origin only** (browser → same server). No external APIs are called from the server. The only external resource loaded in the browser is **Chart.js from a CDN** (`https://cdn.jsdelivr.net`) — no user data is sent to that CDN.

### Complete API Surface

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| GET | `/api/auth/csrf-token` | None | Fetch CSRF token |
| GET | `/api/auth/registration-config` | None | Check if self-registration is enabled |
| GET | `/api/auth/stats` | None | Public count of users & tasks |
| POST | `/api/auth/register` | None | Self-register (password only) |
| POST | `/api/auth/login` | None | Log in |
| POST | `/api/auth/logout` | Logged in | Log out |
| POST | `/api/auth/change-password` | Logged in | Change password |
| POST | `/api/auth/invite` | Logged in | Generate invite credentials |
| GET | `/api/auth/me` | Logged in | Get current user profile |
| GET | `/api/auth/user-groups` | Logged in | List available groups |
| POST | `/api/auth/set-group` | Logged in | Assign self to a group |
| POST | `/api/auth/propose-group` | Logged in | Suggest a new group name |
| GET | `/api/auth/my-options` | Logged in | Get personal dropdown options |
| PUT | `/api/auth/my-options` | Logged in | Save personal dropdown preferences |
| DELETE | `/api/auth/account` | Logged in | Self-delete account |
| POST | `/api/tasks/start` | Logged in | Start a new task (stopwatch begins) |
| GET | `/api/tasks/active` | Logged in | Retrieve the current in-progress task |
| PATCH | `/api/tasks/:id` | Logged in | Update task (save interruptions, complete, discard, edit) |
| GET | `/api/tasks/` | Logged in | List tasks with optional filters |
| GET | `/api/tasks/:id` | Logged in | Get a single task |
| DELETE | `/api/tasks/:id` | Logged in | Delete one task |
| DELETE | `/api/tasks/` | Logged in | Delete all completed/discarded tasks |
| POST | `/api/tasks/pending-count` | Logged in | Log a pending-task count snapshot |
| GET | `/api/tasks/pending-count` | Logged in | Get latest pending-task count |
| GET | `/api/tasks/pending-count/history` | Logged in | Pending count history (7 or 30 days) |
| GET | `/api/tasks/recent-count` | Logged in | Count of completed tasks in last 7 days |
| GET | `/api/analytics/session` | Logged in | Today's tasks + summary statistics |
| GET | `/api/analytics/history` | Logged in | Up-to-30-day history with filters |
| GET | `/api/analytics/export` | Logged in | Download raw task log as `.xlsx` |
| GET | `/api/analytics/report` | Logged in | Download analytics report as `.xlsx` (one sheet per chart) |
| GET | `/api/dropdowns/:field` | Logged in | List dropdown values for a field |
| POST | `/api/dropdowns/propose` | Logged in | Propose a new dropdown value |
| GET/POST/PUT/DELETE | `/api/dropdowns/admin/*` | Admin only | Manage dropdown options |
| GET/POST/DELETE | `/api/admin/users/*` | Admin only | User management |
| GET/POST | `/api/admin/settings` | Admin only | Registration settings |
| GET/POST | `/api/admin/user-groups/*` | Admin only | Group management |
| GET | `/api/admin/backup` | Admin only | Download full DB backup |
| POST | `/api/admin/restore` | Admin only | Restore DB from file upload |
| GET | `/api/version` | None | App version (for cache-busting) |
| GET | `/readyz` | None | Health-check |

---

## 5. User-Facing Data Entry — All Forms and Prompts

### Registration (`public/js/app.js` ~line 893)

| Field | Input type | Validation / hint |
|---|---|---|
| Password | Password field | Min 8 chars + at least one special character (`!@#$%…`). Hint shown below field. |
| Confirm password | Password field | Must match |
| Policy checkbox | Checkbox | "I have read the Data & Use Policy and I understand I must **never enter patient or identifiable information**." Mandatory. |

The username is **not entered** — it is auto-generated by the server and displayed once after registration (e.g. *BoldMoss*). A "Write it down" warning is displayed prominently.

### Login (`public/js/app.js` ~line 553)

| Field | Input type | Placeholder |
|---|---|---|
| Username | Text | "Enter your username" |
| Password | Password | "Your password" |

### Force-change password (admin-created accounts, `public/js/app.js` ~line 1020)

| Field | Input type | Note |
|---|---|---|
| New password | Password | "Min 8 chars + special character" |
| Confirm new password | Password | Must match |

Optional current-password field shown when not a forced change.

### Group Selection (`public/js/app.js` ~line 696)

User picks from a list of admin-approved group names. Can also type a **group name suggestion** in a text input (max 100 chars). Warning shown: *"Do not include your name, department, or any identifying information in a group suggestion."*

### Customise My Options (`public/js/app.js` ~line 813)

A checklist of all dropdown options (Task From, Task Type, Outcome) with checkboxes — tick/untick to personalise. Can suggest new options inline. Warning: *"When suggesting new options, do not include any patient, staff, location, or other personally identifiable information."*

### Start Task Form (`public/js/app.js` ~line 1383)

| Field | Input type | Required? |
|---|---|---|
| Task type | Toggle button (👤 Personal / 🏥 My Group) | Yes — must pick one |
| Task From (category) | Searchable combobox | Yes |
| Task Type (subcategory) | Searchable combobox | Yes |
| Date assigned | Date picker (default: today) | No — defaults to today |

Inline "Add new option…" is available in each combobox, which submits the value to an admin review queue.

### End / Complete Task Review (`public/js/app.js` ~line 1651)

| Field | Input type | Required? |
|---|---|---|
| Outcome | Searchable combobox | Yes — must be selected to submit |
| Start time | datetime-local | Yes (pre-filled from stopwatch) |
| End time | datetime-local | Yes (pre-filled from when End was pressed) |
| Date assigned | Date picker | No |
| Notes | Textarea (collapsible on new tasks) | No. Warning: *"⚠️ DO NOT enter any patient names, initials, or identifiable information."* Max 2000 chars. |
| Interruptions | Listed with remove buttons | N/A |

Two submit options: **"Submit & add another"** (returns to task start) or **"Submit & analytics"** (goes to analytics view).

### Manual Interruption Form (modal, `public/js/app.js` ~line 1585)

| Field | Input type | Note |
|---|---|---|
| Interruption started | datetime-local | Pre-filled to when modal opened |
| Interruption ended | datetime-local | Pre-filled to now |

### Pending Tasks Count (Home screen, `public/js/app.js` ~line 1129)

| Field | Input type | Validation |
|---|---|---|
| Count | Number input (0–9999) | "Enter count…" — integer, 0–9999 |

### Delete Account (`public/js/app.js` ~line 1334)

| Field | Input type | Purpose |
|---|---|---|
| Username | Text | Must exactly match the account username to confirm |
| Password | Password | Must be correct to confirm |

### Privacy Splash (shown at every login, `public/js/app.js` ~line 648)

A full-screen modal displayed after each successful login, listing prohibited items:

- Patient names, initials, or any identifier
- NHS numbers, dates of birth, or addresses
- Anything that could identify a patient, colleague, or third party
- Confidential clinical details

User must tap **"✓ I Understand — Continue"** before proceeding.

### Analytics Filters (`public/js/app.js` ~line 1908)

Date range pickers (from/to), task type toggle, category/subcategory/outcome dropdowns — these filter the display of already-saved data, not new input.

### Admin Panel Inputs

- Add User Group: single text input via `prompt()`, max 80 chars
- Rename Group/Dropdown: `prompt()` dialog
- Add dropdown option: text input, max 100 chars (enforced server-side)
- Registration settings: two dropdown selects (`disabled` / `admin_approved` / `auto`)

---

## 6. Explicit Guidance on Avoiding Patient / Personal Data

This is the most heavily enforced non-technical constraint. It appears at multiple layers:

### Policy page (`public/policy.html`)

- **Lines 26–28** (red warning box): *"⚠️ CRITICAL: You must NEVER enter any patient names, initials, NHS numbers, dates of birth, staff names, or any other information that could identify a patient or staff member."*
- **Lines 46–48**: Lists what is *never* collected (NHS numbers, real names, emails, etc.)
- **Lines 51–53** (blue info box): *"The free-text notes field is provided for task metadata only. You are personally responsible for ensuring no identifiable information — including patient or staff names — is entered into it."*
- **Lines 68–76** (User Responsibilities): detailed bullet list of prohibitions; user is responsible for keeping their device and network connection secure.

### Help guide (`public/help.html`)

- **Lines 62–64** (red warning box): *"⚠️ IMPORTANT: Never type patient names, initials, NHS numbers, or any information that could identify a patient or a colleague."*
- Notes field description (line 176): *"Never enter patient names or any identifying information here."*

### UI at every entry point (`public/js/app.js`)

- Privacy splash on every login (lines 648–693) — requires active confirmation before proceeding
- Registration policy checkbox (lines 921–924)
- Notes textarea: `"⚠️ DO NOT enter any patient names, initials, or identifiable information."` (lines 1688, 1692)
- Group suggestion input: *"⚠️ Do not include your name, department, or any identifying information"* (line 728)
- Option customisation: *"do not include any patient, staff, location, or other personally identifiable information"* (lines 843–844)

### Important limitation

The server does **not** technically scan for or block PII text in free-text fields. The responsibility is entirely behavioural/policy-based, reinforced through UI warnings. The policy explicitly states: *"You are personally responsible for ensuring no identifiable information… is entered into it."*

---

## 7. Privacy and Security Measures

### Authentication

- **Session-based auth** with `express-session`; session stored in SQLite (`data/sessions.db`). `src/server.ts` lines 55–68
- Sessions are **HTTP-only, SameSite=strict** cookies; `secure: true` in production (`NODE_ENV=production`)
- **30-minute inactivity timeout** enforced both server-side (middleware checks `lastActivity`) and client-side (localStorage timestamp). `src/middleware/index.ts` lines 7–10
- **Sessions expire at midnight** — cannot span midnight. `src/middleware/index.ts` lines 13–17
- Sessions are regenerated (new `csrfToken`) on each login. `src/routes/auth.ts` line 119

### Password Security

- **bcrypt with cost factor 12** (`bcryptjs`). `src/routes/auth.ts` lines 43, 152
- Password must be ≥8 chars with at least one special character (server-side regex). `src/routes/auth.ts` line 9
- **Timing-safe invalid user check** — even for unknown usernames, a bcrypt hash comparison is performed to prevent user enumeration via timing. `src/routes/auth.ts` lines 87–88
- **Account lockout after 3 failed attempts**; admin must manually unlock. `src/routes/auth.ts` lines 101–108. Users are told how many attempts remain before lockout.

### CSRF Protection

- Every mutating request (POST/PATCH/PUT/DELETE) must include an `X-CSRF-Token` header matching the session token. `src/middleware/index.ts` lines 49–57
- Token is obtained from `GET /api/auth/csrf-token` and sent in every state-changing API call. `public/js/app.js` lines 417–438

### Rate Limiting (`src/server.ts` lines 71–72)

- Auth routes: **20 requests per 15 minutes** (`skipSuccessfulRequests: true`)
- All API routes: **200 requests per minute**

### HTTP Security Headers

- **Helmet.js** sets Content-Security-Policy (only `'self'` + `cdn.jsdelivr.net` for Chart.js), X-Frame-Options, X-Content-Type-Options, and others. `src/server.ts` lines 36–50

### Encryption at Rest

- The `notes` field in `tasks` is **AES-256-GCM encrypted** when `ENCRYPTION_KEY` is set in the environment (64-char hex string = 32 bytes). `src/encrypt.ts`
- Each value has a unique random IV; GCM provides authenticated encryption (tamper detection)
- On decryption, if no key is set, `null` is returned rather than the raw ciphertext
- If `ENCRYPTION_KEY` is **not** set, notes are stored as plaintext. The `.env.example` notes: *"not recommended for production."*

### HTTPS / TLS

- Auto-detected: if Let's Encrypt certificate files exist, the server starts HTTPS; otherwise plain HTTP. `src/server.ts` lines 29–33, 136–147
- `upgradeInsecureRequests` CSP directive is enabled only when running HTTPS

### Access Control (IDOR Prevention)

- Every task query includes `AND user_id=?` binding — users can only read, update, or delete their own tasks. `src/routes/tasks.ts` lines 66, 88, 149, 160, 165
- The admin API enforces `requireAdmin` middleware on every route. `src/routes/admin.ts` line 12
- Admins have access to **only counts** (userCount, taskCount, pendingCount) — no access to any user's actual task data, notes, analytics, or timestamps. `src/routes/admin.ts` lines 17–25

### Path Traversal Protection

- DB restore endpoint validates that the uploaded file path is strictly within the `data/restore-tmp/` directory before copying. `src/db.ts` lines 41–43; `src/routes/admin.ts` lines 268–272

### Event Logging (Anonymised)

- The `events` table stores only `event_type` (e.g. `task_started`, `user_login`) and `created_at`. **No user ID is stored** in the events table. `src/middleware/index.ts` lines 60–65; `src/db.ts` line 117
- Administrators can see aggregate counts but cannot correlate events to individual users

### SQL Injection Prevention

- All queries use `better-sqlite3` **parameterised statements** (`prepare(…).run(…)` / `.get(…)` / `.all(…)`) throughout. No string-interpolated SQL.

### Input Validation (Server-side)

- Notes max length: 2000 chars (`src/routes/tasks.ts` lines 73–75, 101–103)
- Pending count: integer 0–9999 (`src/routes/tasks.ts` lines 41–43)
- Dropdown values: max 100 chars; field name must be `category`/`subcategory`/`outcome` (`src/routes/dropdowns.ts` lines 6, 54–55)
- Group names: max 100 chars (user proposals), max 80 chars (admin-created)
- Task start/end times must be today for active tasks; start must precede end (`src/routes/tasks.ts` lines 92–109)
- Password regex enforced server-side (`src/routes/auth.ts` line 37)

### Security Test Suite

- 52 automated negative tests in `src/__tests__/security.test.ts` covering CSRF, IDOR, SQL injection, XSS, input validation, resource exhaustion, temporal consistency, path traversal, and group access control. Run with `npm test`.

---

## 8. End-to-End User Workflow

### Logging a Task (complete flow)

1. **Open app / Log in** → Privacy splash modal appears; user taps "I Understand — Continue"
   - First-time user: must select a group, then optionally customise dropdown options (checkboxes)
2. **Home screen** → Tap **"▶ Log Task"**
3. **Task Start form** → Pick "My Group" or "Personal" · select Task From (category) · select Task Type (subcategory) · optionally change Date Assigned · tap **"▶ Start Timer"**
4. **Timer screen** → Stopwatch counts up. If interrupted, tap "⏸️ Interrupted":
   - "Resume — continue from here" (records interruption automatically)
   - "Enter interruption times manually" (datetime-local form)
   - "Discard this task"
5. **End task** → Tap "⏹️ End Task" → Review screen:
   - Select Outcome (required)
   - Optionally adjust start/end times
   - Optionally add Notes (with prominent warning against PII)
   - Remove any erroneous interruptions
   - Tap **"Submit & analytics"** or **"Submit & add another"**
6. **Analytics view** → Today's session summary: task count, total minutes, duty/personal split, pie/bar charts, individual task list with ✏️ Edit buttons

### Viewing and Exporting Data

1. Tap **"📊 Analytics"** in the bottom nav → Today's session view
2. Tap **"📅 Long-term History"** → Up to 30 days; filter by date/type/category/outcome; linear regression trendline appears with ≥3 days of data
3. The analytics section presents charts grouped into four logical sections:
   - **Overview**: time by category (doughnut), My Group vs Personal split, outcome distribution, outcome breakdown by category (stacked bar, when >1 category)
   - **Task types & durations**: tasks by type, avg duration by category, avg duration by task type, task types by source group (stacked bar, when cross-tab data is meaningful)
   - **Flags**: flag distribution, flags by source group (stacked bar)
   - **Temporal patterns**: activity by hour and day of week, task type patterns by day of week (stacked, when ≥2 types), tasks/time over time with regression overlay, interruptions trend, assignment-to-action lag histogram (for tasks with an assigned date)
4. Tap **"⬇️ Download Log (.xlsx)"** → Downloads `Tasker-YYYYMMDDHHmm.xlsx` with two sheets:
   - **Tasks** sheet: Type, Task From, Task Type, Outcome, Date Assigned, Start Time, End Time, Duration (secs), Interruptions count, Flags
   - **Summary** sheet: Latest pending task count and when it was logged
5. Tap **"📊 Download Analytics (.xlsx)"** → Downloads `Tasker-Analytics-YYYYMMDDHHmm.xlsx` with one data-table sheet per chart, matching all graphical output for the current filter period. Sheets included: Summary, Time by Category, Duty vs Personal, Outcome Distribution, Outcome by Category, Avg Duration (Category), Tasks by Type, Avg Duration (Task Type), Task Types by Source Group, Flag Distribution, Flags by Source Group, Activity by Hour, Activity by Day of Week, Task Types by Day Assigned, Personal by Day (Origin), Personal by Day (Type), Tasks Over Time (with optional regression trend column), Interruptions Over Time, Assignment Lag. Only sheets with relevant data are included.

---

## 9. Summary

### What Tasker stores

Task metadata (times, categories, outcome, optional free-text notes), anonymous usernames, hashed passwords, and aggregate event counts. No names, NHS numbers, emails, or any personally identifying information is ever solicited or stored by design.

### Where it lives

Entirely on the deploying organisation's own server. Two SQLite files, no cloud dependencies.

### How it protects data

Session authentication with 30-minute expiry and midnight cutoff; CSRF tokens on every write; bcrypt passwords with cost factor 12; account lockout after 3 failed logins; rate limiting; Helmet security headers; optional AES-256-GCM encryption of free-text notes at rest; HTTPS auto-detection; access-controlled so each user sees only their own data; admin sees only counts.

### What it cannot prevent

If a user deliberately or accidentally types patient or staff information into the notes field or a dropdown suggestion, the application will store it (encrypted if configured) but cannot detect or block the input. The policy, help guide, privacy splash, and inline warnings all explicitly prohibit this and make the user personally responsible.

### Data lifetime

Tasks are automatically and permanently deleted after 30 days. Accounts persist until self-deleted or admin-deleted.
