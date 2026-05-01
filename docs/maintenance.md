# Tasker — Maintenance and Troubleshooting Manual

**Version 1.12.4 — April 2026**

---

## Contents

1. [Routine maintenance tasks](#routine-maintenance-tasks)
2. [Database backups](#database-backups)
3. [Database restore](#database-restore)
4. [Updating the application](#updating-the-application)
5. [User management](#user-management)
6. [User group management](#user-group-management)
7. [Dropdown option management](#dropdown-option-management)
8. [Health-check endpoint](#health-check-endpoint)
9. [Log inspection](#log-inspection)
10. [Troubleshooting guide](#troubleshooting-guide)
11. [Security considerations](#security-considerations)
12. [Data retention](#data-retention)

---

## Routine maintenance tasks

| Task | Frequency | Method |
|---|---|---|
| Verify the service is running | Daily (automated) | `systemctl is-active tasker` |
| Review application logs for errors | Weekly | `journalctl -u tasker --since "7 days ago"` |
| Download a database backup | Weekly | Admin panel → Download Backup |
| Check SSL certificate expiry | Monthly | `certbot certificates` |
| Verify automatic renewal | Monthly | `sudo certbot renew --dry-run` |
| Review registered users | Monthly | Admin panel → Users |
| Clear stale user accounts | As needed | Admin panel → Delete user |
| Apply OS security updates | Weekly | `sudo apt update && sudo apt upgrade` |
| Update Node.js | When LTS releases | See [Updating the application](#updating-the-application) |

---

## Database backups

Tasker stores all data in two SQLite files in the `data/` directory:

| File | Contents |
|---|---|
| `data/tasker.db` | Users, tasks, dropdown options, events |
| `data/sessions.db` | Active login sessions (safe to discard) |

### Backup via the admin panel (recommended)

1. Log in as admin.
2. Scroll to the **Database** section.
3. Tap **💾 Download Backup**.
4. The file is downloaded as `tasker-backup-<timestamp>.db`.

Store backup files in a separate location (external drive, encrypted cloud storage, or a different server). Do not store backups only on the same machine as the application.

### Automated backup via cron

Add a cron job to copy the database file nightly:

```bash
sudo crontab -e
```

```cron
# Tasker database backup — nightly at 02:00
0 2 * * * cp /opt/tasker/data/tasker.db /var/backups/tasker/tasker-$(date +\%Y\%m\%d).db
```

Create the backup directory first:

```bash
sudo mkdir -p /var/backups/tasker
sudo chown tasker:tasker /var/backups/tasker
```

To retain only the last 30 backups, add a cleanup line:

```cron
5 2 * * * find /var/backups/tasker -name "*.db" -mtime +30 -delete
```

### Important notes

- The application uses SQLite WAL (Write-Ahead Logging) mode. A simple file copy is safe while the application is running because WAL mode provides consistent reads.
- If you prefer a true hot backup, use the SQLite `.backup` command:

  ```bash
  sqlite3 /opt/tasker/data/tasker.db ".backup '/var/backups/tasker/tasker-safe.db'"
  ```

---

## Database restore

### Via the admin panel

1. Log in as admin.
2. Scroll to the **Database** section.
3. Tap **📤 Restore from Backup** and select a `.db` backup file.

> ⚠️ **This replaces the current database immediately and cannot be undone.** All data since the backup was taken will be lost. Download a fresh backup first if you want to preserve current data.

### Via the command line

Stop the service, replace the file, and restart:

```bash
sudo systemctl stop tasker
sudo cp /var/backups/tasker/tasker-20260401.db /opt/tasker/data/tasker.db
sudo chown tasker:tasker /opt/tasker/data/tasker.db
sudo systemctl start tasker
```

---

## Updating the application

### 1. Pull the latest code

```bash
cd /opt/tasker
git pull origin main        # or the appropriate branch
```

### 2. Install any new dependencies

```bash
npm install
```

### 3. Rebuild

```bash
npm run build
```

### 4. Restart the service

```bash
sudo systemctl restart tasker
sudo systemctl status tasker
```

### Updating Node.js

Use `nvm` (Node Version Manager) or your system package manager. After updating Node.js, rebuild native dependencies:

```bash
npm rebuild better-sqlite3
npm run build
sudo systemctl restart tasker
```

---

## User management

All user management is done from the **Admin Panel**, accessible by logging in as the admin account.

### Registration settings

The Admin Panel includes a **Registration Settings** section with two configurable policies:

| Setting | Description |
|---|---|
| **Self-registration** | Controls whether the Register button is shown on the login page |
| **User invitations** | Controls whether logged-in users can invite others via the Settings page |

Each setting has three options:

| Option | Behaviour |
|---|---|
| **Disabled** | The feature is hidden and unavailable |
| **Administrator approval** (default) | Accounts are created but marked pending. The user sees their username but cannot log in until an admin approves the account in the **Pending User Approvals** section |
| **Automatic approval** | Accounts are immediately active |

### Adding a user (admin-created)

Tap **➕ Add User**. The system generates a random username and a temporary password. A copy button and a pre-formatted invite message are displayed — share these with the new user through a secure channel (e.g. in person or via an encrypted messaging app). The user will be required to set a new password on their first login. Admin-created users are always immediately active.

### Approving pending users

When self-registration or user invitations are set to **Administrator approval**, new accounts appear in the **Pending User Approvals** section of the Admin Panel. Tap **✓ Approve** to activate the account, or **✗ Reject** to delete it.

### User invitations

If the **User invitations** setting is not Disabled, a **👤 Invite a User** button appears in the Settings page for logged-in users. This generates a temporary-password invite in the same way as admin-created accounts. If the setting is **Administrator approval**, the invited account will be pending until an admin approves it.

### Resetting a user's password

Tap **🔑 Reset** next to the user. A new temporary password is generated. Share it with the user securely. Their account must-change-password flag is set automatically.

### Unlocking a locked account

If a user fails login too many times, their account is locked. Tap **🔓 Unlock** next to the user to re-enable access. No data is lost.

### Assigning users to groups

Tap **👥 Group** next to a user to assign them to a user group. User groups control which dropdown options appear in that user's task forms. A user without a group assigned will see all approved dropdown options.

### Deleting a user

Tap **🗑** next to the user. This permanently and immediately deletes the account and all associated task data. This cannot be undone.

---

## User group management

User groups allow different teams or roles to see different sets of dropdown options in their task forms.

### Creating a group

In the **User Groups** section of the Admin Panel, tap **➕ Add User Group**, type a name, and confirm. The group is created with no options assigned — configure its options next.

### Configuring group options

Tap **⚙️ Options** next to a group. A dialog appears showing all approved dropdown options with tick-boxes. Tick the options that should appear for users in this group and tap **Save**.

### Renaming a group

Tap **✏️ Rename** next to the group, enter the new name, and confirm.

### Reviewing group proposals

Users can suggest new group names from the group-selection screen. Proposed groups appear in the **Pending Group Proposals** section of the Admin Panel. Tap **✓ Approve** to make the group visible to users, or **✗ Reject** to discard it. Approved groups have no options assigned by default — configure them via **⚙️ Options**.

### Deleting a group

Tap **🗑** next to the group. Users assigned to that group will have their group membership cleared (their task data is not affected).

---

## Dropdown option management

The **Dropdown Options** section of the Admin Panel controls which choices appear in the Task From (category), Task Type (subcategory), and Outcome fields across the whole system. Individual groups can be configured to show a subset of these options (see [User group management](#user-group-management) above).

### Adding options directly

In the relevant section (Task from, Task type, or Outcome), type the new option in the input field and tap **Add**.

### Reviewing user proposals

Users can suggest new options while recording tasks or from the ⚙️ Customise My Options screen. These appear in the **Pending User Proposals** section. Tap **✓ Approve** to make an option available to all users, or **✗ Reject** to discard it. Approved options are not automatically added to any group — assign them via the group's **⚙️ Options** dialog if needed.

### Removing options

Tap **✕** next to any existing option to delete it. Existing tasks that used that option are not affected — the option value is stored directly on the task record.

---

## Health-check endpoint

Tasker exposes `GET /readyz` for uptime monitoring and heartbeat polling. No authentication is required.

**Response format:**

```json
{
  "ok": true,
  "service": "Tasker",
  "version": "1.9.2",
  "timestamp": "2026-04-04T12:09:26.477Z"
}
```

**Example curl check:**

```bash
curl -s https://yourdomain.example.com/readyz | python3 -m json.tool
```

Configure your polling/heartbeat server to `GET /readyz` and alert if the response is not HTTP 200 or `ok` is not `true`.

---

## Log inspection

### Application logs (systemd)

```bash
# All logs since last boot
sudo journalctl -u tasker -b

# Last 100 lines
sudo journalctl -u tasker -n 100

# Follow in real time
sudo journalctl -u tasker -f

# Errors only
sudo journalctl -u tasker -p err

# Logs from a specific time period
sudo journalctl -u tasker --since "2026-04-01 00:00" --until "2026-04-01 23:59"
```

### Nginx access and error logs (if applicable)

```bash
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### Event counts

The application logs anonymised event counts (logins, task starts, completions, admin actions). These are visible in the Admin Panel under the stats cards (registered users, events logged). No personally identifiable information is attached to these counts.

---

## Troubleshooting guide

### The service will not start

**Check the logs:**

```bash
sudo journalctl -u tasker -n 50 --no-pager
```

**Common causes:**

| Symptom | Cause | Fix |
|---|---|---|
| `Error: Cannot find module 'dist/server.js'` | Application has not been built | Run `npm run build` |
| `Error: EACCES permission denied` on `data/` | Wrong file ownership | `sudo chown -R tasker:tasker /opt/tasker/data` |
| `Error: EADDRINUSE :::3020` | Another process is using port 3020 | Change `PORT` in `.env` or stop the conflicting process |
| `Error: Could not locate the bindings file` for `better-sqlite3` | Node.js version mismatch or native module not compiled | Run `npm rebuild better-sqlite3` then rebuild |
| `SESSION_SECRET` warning | `SESSION_SECRET` not set | Add it to `.env` |

### The application starts but shows a blank screen / spinner

- Open the browser developer tools.
- Check for network errors — the browser is likely unable to reach `/api/auth/csrf-token`.
- Verify the server is running: `systemctl status tasker`.
- Check that the reverse proxy is correctly forwarding requests.

### Users cannot log in

| Symptom | Cause | Fix |
|---|---|---|
| "Incorrect username or password" | Wrong credentials | Reset password via admin panel |
| "This account has been locked" | Too many failed attempts | Unlock via admin panel |
| "Your account is pending administrator approval" | Account created via self-registration or user invite with approval required | Approve the account in Admin Panel → Pending User Approvals |
| "Not authenticated" after successful login | Session cookies not being set | Ensure `NODE_ENV=production` is set when using HTTPS; check `secure` cookie setting |
| Login works on HTTP but not HTTPS | `secure` cookie flag requires HTTPS | Serve the app over HTTPS in production |

### SSL / HTTPS issues

**Certificate not found — server starts in HTTP mode:**

```bash
ls -la /etc/letsencrypt/live/yourdomain.example.com/
```

Ensure both `fullchain.pem` and `privkey.pem` exist and are readable by the `tasker` user or are world-readable.

**Certificate expired:**

```bash
sudo certbot renew
sudo systemctl restart tasker
```

**Mixed content warnings:**

Ensure all requests use HTTPS. If behind a reverse proxy, confirm the proxy sets `X-Forwarded-Proto: https`.

### Database errors

**`database is locked`:**

This indicates two processes are writing to the database simultaneously. Only one instance of Tasker should run at a time. Check for duplicate service instances:

```bash
ps aux | grep "node dist/server.js"
```

**Database file corrupted:**

```bash
sqlite3 /opt/tasker/data/tasker.db "PRAGMA integrity_check;"
```

If the output is not `ok`, restore from a backup (see [Database restore](#database-restore)).

**`no such column` error after upgrade:**

The application applies migrations automatically on startup via the `initSchema` function. If a migration fails, check logs for the SQL error. Restore from backup and try again if needed.

### Performance issues

- SQLite WAL mode is enabled by default and handles concurrent reads well.
- The application is designed for small teams (tens of users). For very large deployments, consider scheduling backups and the retention job during off-peak hours.
- If response times are slow, check system resource usage: `top` or `htop`.

### The app works on HTTP but shows errors on HTTPS

- Verify `NODE_ENV=production` is set.
- Verify the reverse proxy is sending `X-Forwarded-Proto: https`.
- Verify `app.set('trust proxy', 1)` is present in `src/server.ts` (it is, by default).

---

## Security considerations

### Session secret rotation

If you suspect the `SESSION_SECRET` has been compromised, generate a new one and restart the service. All active sessions will be invalidated and users will need to log in again.

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Update `.env` and restart:

```bash
sudo systemctl restart tasker
```

### Admin password

Change the admin password immediately after installation and periodically thereafter. Use a long, unique password stored in a password manager.

### File permissions

```bash
# Restrict .env from other users
chmod 600 /opt/tasker/.env

# Data directory writable only by the tasker user
chmod 700 /opt/tasker/data
```

### Dependency updates

Periodically check for security advisories:

```bash
npm audit
```

To update all dependencies within their allowed version ranges:

```bash
npm update
npm run build
sudo systemctl restart tasker
```

For major version updates, test in a non-production environment first.

### Known dependency advisory

The `uuid` package (used transitively by `exceljs`) has a moderate advisory (GHSA-w5hq-g745-h8pq) affecting the `v3`/`v5`/`v6` UUID generation functions when a caller-supplied `buf` parameter is provided. `exceljs` uses only `uuidv4()` without a `buf` parameter, so this code path is never reached and the practical risk is zero. The advisory is tracked and will be resolved when `exceljs` releases an update that pins a safe version of `uuid`.

### Rate limiting

The application applies rate limits by default:
- Authentication endpoints: 20 requests per 15 minutes per IP
- API endpoints: 200 requests per minute per IP

These limits are defined in `src/server.ts` and can be adjusted if needed, but tightening them is generally preferable to loosening them.

---

## Data retention

Task records older than 30 days are automatically deleted every 24 hours. This runs in the background without any manual action.

- The retention job runs on startup and then every 24 hours.
- Deletions are logged to the console: `[Retention] Deleted N tasks >30 days`.
- User accounts and session records are not affected by the retention job — only task data.
- The retention period (30 days) is defined in `src/server.ts` and can be adjusted by editing the `runRetention` function and the interval, then rebuilding.
