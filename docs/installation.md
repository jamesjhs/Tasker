# Tasker — Installation Manual

**Version 1.12.3 — April 2026**

---

## Contents

1. [Overview](#overview)
2. [Requirements](#requirements)
3. [Obtaining the code](#obtaining-the-code)
4. [Installing dependencies](#installing-dependencies)
5. [Environment configuration](#environment-configuration)
6. [Building the application](#building-the-application)
7. [First run and admin account creation](#first-run-and-admin-account-creation)
8. [Admin two-factor authentication (2FA)](#admin-two-factor-authentication-2fa)
9. [SSL / HTTPS configuration](#ssl--https-configuration)
10. [Running as a persistent service (systemd)](#running-as-a-persistent-service-systemd)
11. [Reverse proxy with Nginx](#reverse-proxy-with-nginx)
12. [Reverse proxy with Caddy](#reverse-proxy-with-caddy)
13. [Firewall](#firewall)
14. [Post-install checklist](#post-install-checklist)

---

## Overview

Tasker is a Node.js application that stores its data in a local SQLite database file. It has no external database dependencies. The application serves a web interface over HTTP or HTTPS (automatically detected).

Architecture summary:

```
Node.js (Express 5)
  └── SQLite database  →  data/tasker.db
  └── Session database →  data/sessions.db
  └── Static files     →  public/
  └── Compiled source  →  dist/
```

---

## Requirements

| Component | Minimum | Recommended |
|---|---|---|
| Node.js | 20.x | 24.x LTS |
| npm | 9.x | latest |
| OS | Any Linux | Ubuntu 22.04 LTS / Debian 12 |
| RAM | 256 MB | 512 MB |
| Disk | 200 MB | 1 GB |

> **Node 24 is required for `better-sqlite3@12.x`.** Check your version with `node --version`.

---

## Obtaining the code

Clone the repository or copy the source files to the server:

```bash
# From GitHub
git clone https://github.com/jamesjhs/Tasker.git /opt/tasker
cd /opt/tasker
```

Or upload a `.zip` / `.tar.gz` archive and extract:

```bash
mkdir -p /opt/tasker
tar -xzf tasker-1.3.0.tar.gz -C /opt/tasker --strip-components=1
cd /opt/tasker
```

---

## Installing dependencies

```bash
npm install
```

This installs all runtime and build-time dependencies listed in `package.json`. The `npm overrides` section forces specific transitive dependency versions to eliminate deprecation warnings — no action is needed from you.

---

## Environment configuration

Copy the example environment file and edit it:

```bash
cp .env.example .env
nano .env          # or use your preferred editor
```

### Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Port the application listens on | `3020` |
| `SESSION_SECRET` | A long, random secret string used to sign session cookies. **Must be set in production.** | Random (changes on every restart) |
| `NODE_ENV` | Set to `production` to enable secure (HTTPS-only) cookies | — |
| `APP_URL` | Full public URL of the server (no trailing slash). Used to generate clickable review links in suggestion emails. | — |
| `SSL_CERT_DIR` | Directory containing Let's Encrypt certificate files | `/etc/letsencrypt/live/yourdomain` |
| `SSL_CERT` | Full path to the certificate chain file | `$SSL_CERT_DIR/fullchain.pem` |
| `SSL_KEY` | Full path to the private key file | `$SSL_CERT_DIR/privkey.pem` |

### Generating a session secret

```bash
node -e "const c=require('crypto');console.log(c.randomBytes(64).toString('hex'))"
```

Copy the output into your `.env` file as the `SESSION_SECRET` value.

### Example `.env` for production

```ini
PORT=3020
SESSION_SECRET=<output of the command above>
NODE_ENV=production
APP_URL=https://tasker.jahosi.co.uk
SSL_CERT_DIR=/etc/letsencrypt/live/yourdomain.example.com
```

---

## Building the application

Compile the TypeScript source to JavaScript:

```bash
npm run build
```

This produces a `dist/` directory. The compiled output (`dist/server.js`) is what runs at runtime.

> Re-run `npm run build` after any change to files in `src/`.

---

## First run and admin account creation

### 1. Start the server once to initialise the database

```bash
node dist/server.js
```

The server will create the `data/` directory and the SQLite databases automatically on first start. You will see output such as:

```
Tasker running on port 3020 (HTTP – no SSL certs found)
```

Press `Ctrl+C` to stop after the databases have been created.

### 2. Create the admin account

Run this command once from the `/opt/tasker` directory (while the server is stopped, or while it is running — either works):

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

### 3. Log in and change the admin password

Open the application in a browser. Log in with:

- **Username:** `admin`
- **Password:** `Admin123!`

You will be immediately prompted to set a new password. Choose something long and unique.

---

## Admin two-factor authentication (2FA)

After completing initial setup, the administrator can enable email-based 2FA from **Admin Panel → Admin Two-Factor Authentication (2FA)**. When enabled, a one-time six-digit code is sent to the configured admin email address on every admin login.

### Enabling 2FA

1. Configure SMTP settings in the Admin Panel so that emails can be sent.
2. Navigate to **Admin Panel → Admin Two-Factor Authentication (2FA)**.
3. Optionally enter a **backup email address** — codes will be sent there as well.
4. Tick **Enable 2FA for admin login** and click **Save 2FA Settings**.

> The primary email address used for codes is the address in the SMTP **"Send suggestions to"** field.

### Overriding a locked or inaccessible admin account from the server CLI

If you are locked out of the admin account (e.g. 2FA email is unreachable, or the account has been locked after failed attempts), you can reset it directly from the server command line while the application is **stopped**:

```bash
# Disable 2FA and unlock the admin account
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/tasker.db');
db.prepare('UPDATE users SET mfa_enabled=0, mfa_backup_email=NULL, is_locked=0, failed_login_attempts=0 WHERE is_admin=1').run();
console.log('Admin 2FA disabled and account unlocked.');
db.close();
"
```

To also reset the admin password at the same time:

```bash
node -e "
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const db = new Database('data/tasker.db');
const hash = bcrypt.hashSync('Admin123!', 12);
db.prepare('UPDATE users SET password_hash=?, must_change_password=1, mfa_enabled=0, mfa_backup_email=NULL, is_locked=0, failed_login_attempts=0 WHERE is_admin=1').run(hash);
console.log('Admin password reset to Admin123! — change it immediately after logging in.');
db.close();
"
```

Restart the application afterwards and log in with the temporary password.

---

## SSL / HTTPS configuration

The server detects SSL certificates automatically. If both `SSL_CERT` and `SSL_KEY` paths exist on disk, the server starts in HTTPS mode. If they do not exist, it starts in HTTP mode.

### Using Let's Encrypt (recommended)

1. Install Certbot:

   ```bash
   sudo apt install certbot
   ```

2. Obtain a certificate (the domain must point to this server's public IP):

   ```bash
   sudo certbot certonly --standalone -d yourdomain.example.com
   ```

   Certificates are saved to `/etc/letsencrypt/live/yourdomain.example.com/`.

3. Set the certificate directory in `.env`:

   ```ini
   SSL_CERT_DIR=/etc/letsencrypt/live/yourdomain.example.com
   NODE_ENV=production
   ```

4. Restart the application. It will now start in HTTPS mode:

   ```
   Tasker running on port 3020 (HTTPS)
   ```

5. Set up automatic renewal:

   ```bash
   sudo systemctl enable --now certbot.timer
   ```

   Add a post-renewal hook to restart Tasker (see the systemd section below):

   ```bash
   sudo nano /etc/letsencrypt/renewal-hooks/post/tasker.sh
   ```

   ```bash
   #!/bin/bash
   systemctl restart tasker
   ```

   ```bash
   sudo chmod +x /etc/letsencrypt/renewal-hooks/post/tasker.sh
   ```

### Running behind a reverse proxy (HTTP internally)

If you terminate SSL at Nginx or Caddy and forward plain HTTP to Tasker, **do not** set `SSL_CERT` / `SSL_KEY` in `.env`. The application will listen on plain HTTP internally. The `trust proxy` setting is already configured so that `X-Forwarded-For` headers are respected.

---

## Running as a persistent service (systemd)

Create a dedicated system user (recommended):

```bash
sudo useradd --system --no-create-home --shell /bin/false tasker
sudo chown -R tasker:tasker /opt/tasker
```

Create the service file:

```bash
sudo nano /etc/systemd/system/tasker.service
```

```ini
[Unit]
Description=Tasker — anonymous task logger
After=network.target

[Service]
Type=simple
User=tasker
Group=tasker
WorkingDirectory=/opt/tasker
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/opt/tasker/.env

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/tasker/data

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tasker
sudo systemctl status tasker
```

View live logs:

```bash
sudo journalctl -u tasker -f
```

---

## Reverse proxy with Nginx

Install Nginx:

```bash
sudo apt install nginx
```

Create a site configuration (replace `yourdomain.example.com` and the port if changed from `3020`):

```bash
sudo nano /etc/nginx/sites-available/tasker
```

```nginx
server {
    listen 80;
    server_name yourdomain.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.example.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.example.com/privkey.pem;

    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    location / {
        proxy_pass http://127.0.0.1:3020;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable and test:

```bash
sudo ln -s /etc/nginx/sites-available/tasker /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

When using Nginx for SSL, leave `SSL_CERT` and `SSL_KEY` unset in Tasker's `.env` (Tasker listens on plain HTTP) and set `NODE_ENV=production` so that cookies are marked secure.

---

## Reverse proxy with Caddy

Install Caddy:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

Create or edit `/etc/caddy/Caddyfile`:

```
yourdomain.example.com {
    reverse_proxy localhost:3020
}
```

Caddy handles SSL automatically via Let's Encrypt. Reload:

```bash
sudo systemctl reload caddy
```

---

## Firewall

Allow only the ports you need. If using a reverse proxy, block direct access to port 3020 from outside:

```bash
# Using ufw
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # or 443/tcp if not using Nginx
sudo ufw deny 3020            # block direct access to Tasker port
sudo ufw enable
```

---

## Post-install checklist

- [ ] `SESSION_SECRET` is set to a long random string in `.env`
- [ ] `NODE_ENV=production` is set in `.env`
- [ ] HTTPS is working (either directly or via reverse proxy)
- [ ] Admin account has been created and the default password has been changed
- [ ] The application starts automatically on server reboot (`systemctl is-enabled tasker`)
- [ ] Certificate renewal is configured and tested
- [ ] The `data/` directory is included in server backups
- [ ] Direct access to port 3020 is blocked from the public internet (if behind a reverse proxy)
