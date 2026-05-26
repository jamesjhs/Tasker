import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import http from 'http';
import Database from 'better-sqlite3';
import { getDb } from './db';
import authRouter from './routes/auth';
import tasksRouter from './routes/tasks';
import analyticsRouter from './routes/analytics';
import dropdownsRouter from './routes/dropdowns';
import adminRouter from './routes/admin';
import flagsRouter from './routes/flags';
import messagesRouter from './routes/messages';
import reviewRouter from './routes/review';

import { version as APP_VERSION } from '../package.json';
import type { NextFunction, Request } from 'express';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const SqliteStoreFactory = require('better-sqlite3-session-store');
const Store = SqliteStoreFactory(session);
const app = express();
const trustProxyEnv = (process.env['TRUST_PROXY'] || '').trim();
if (!trustProxyEnv) {
  app.set('trust proxy', false);
} else {
  const lower = trustProxyEnv.toLowerCase();
  if (lower === 'true') {
    app.set('trust proxy', 1);
  } else if (lower === 'false') {
    app.set('trust proxy', false);
  } else if (/^\d+$/.test(lower)) {
    app.set('trust proxy', Number(lower));
  } else {
    app.set('trust proxy', trustProxyEnv);
  }
}
const PORT = process.env['PORT'] || 3020;
const SESSION_SECRET = process.env['SESSION_SECRET'] || crypto.randomBytes(64).toString('hex');
const APP_URL = (process.env['APP_URL'] || '').trim().replace(/\/+$/, '');

// ─── SSL configuration ────────────────────────────────────────────────────────
const useHttps = process.env['USE_HTTPS'] === 'true';
const SSL_CERT = process.env['SSL_CERT'] || '';
const SSL_KEY  = process.env['SSL_KEY']  || '';

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://challenges.cloudflare.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://cdn.jsdelivr.net', 'https://challenges.cloudflare.com'],
      frameSrc: ["'self'", 'https://challenges.cloudflare.com'],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"],
      upgradeInsecureRequests: useHttps ? [] : null, // enable when running over HTTPS
    },
  },
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ─── Sessions ─────────────────────────────────────────────────────────────────
const sessionDb = new Database(path.join(__dirname, '..', 'data', 'sessions.db'));
app.use(session({
  store: new Store({ client: sessionDb }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env['NODE_ENV'] === 'production',
    maxAge: 30 * 60 * 1000,
  },
}));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });

// ─── Health-check endpoint (exempt from auth) ─────────────────────────────────
app.get('/readyz', apiLimiter, (_req, res) => {
  res.json({ ok: true, service: 'Tasker', version: APP_VERSION, timestamp: new Date().toISOString() });
});

app.get('/robots.txt', apiLimiter, (req, res) => {
  const origin = getPublicOrigin(req);
  res.type('text/plain').send(
    [
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/',
      'Disallow: /suggest/review/',
      `Sitemap: ${origin}/sitemap.xml`,
    ].join('\n'),
  );
});

app.get('/llms.txt', apiLimiter, (req, res) => {
  const origin = getPublicOrigin(req);
  res.type('text/plain').send(
    [
      '# Tasker',
      '> Anonymous workload logger for NHS and healthcare teams.',
      '',
      `Version: ${APP_VERSION}`,
      'Type: Self-hosted Progressive Web App (PWA)',
      'Stack: Node.js, Express, SQLite, vanilla JavaScript',
      '',
      '## What Tasker does',
      '- Lets healthcare teams log tasks in real time with structured categories, outcomes, and interruption tracking.',
      '- Provides analytics, pending-workload snapshots, XLSX exports, notices, user messages, and role-based dropdown configuration.',
      '- Supports self-registration or admin-issued accounts, optional Cloudflare Turnstile CAPTCHA, and email-based admin 2FA.',
      '',
      '## What Tasker does not do',
      '- Does not store patient data, real names, or email addresses for standard users.',
      '- Does not depend on a cloud database or third-party analytics platform.',
      '- Does not market itself as a clinical record or rostering system.',
      '',
      '## Privacy and deployment facts',
      '- Anonymous usernames are generated automatically.',
      '- Task data is automatically deleted after 30 days.',
      '- Deployment is self-hosted; data stays on the organisation’s own server.',
      '- Admins can publish notices, manage groups/options, and download encrypted-safe SQLite backups.',
      '',
      '## Key URLs',
      `${origin}/`,
      `${origin}/guide`,
      `${origin}/help`,
      `${origin}/policy`,
      `${origin}/dpia`,
      'https://github.com/jamesjhs/Tasker',
    ].join('\n'),
  );
});

app.get('/sitemap.xml', apiLimiter, (req, res) => {
  const origin = getPublicOrigin(req);
  const urls = ['/', '/guide', '/help', '/policy', '/dpia'];
  const today = new Date().toISOString().split('T')[0];
  const body = urls.map(url => (
    `  <url>\n    <loc>${origin}${url}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`
  )).join('\n');
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`,
  );
});

// ─── Static files ─────────────────────────────────────────────────────────────
// Serve sw.js dynamically so its CACHE_NAME always reflects the current app
// version.  The SW's activate handler deletes every cache whose name doesn't
// match CACHE_NAME, so changing the name on each deploy automatically cleans
// up the previous version's cached assets — even if checkAssetVersion() never
// runs (e.g. on a first load after an update, or while offline).
const swContent = fs
  .readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8')
  .replace(/'tasker-__APP_VERSION__'/g, `'tasker-${APP_VERSION}'`);
const indexTemplate = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function getPublicOrigin(req: Request): string {
  return APP_URL || `${req.protocol}://${req.get('host')}`;
}

function renderIndexHtml(req: Request): string {
  const origin = getPublicOrigin(req).replace(/\/+$/, '');
  return indexTemplate
    .replace(/__APP_VERSION__/g, APP_VERSION)
    .replace(/__APP_ORIGIN__/g, origin);
}

app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(swContent);
});

app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      // Always revalidate the HTML shell so clients pick up new asset fingerprints
      // immediately, even when the Service Worker has been bypassed or not yet active.
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// ─── API routes ───────────────────────────────────────────────────────────────
app.get('/api/version', apiLimiter, (_req, res) => {
  res.json({ version: APP_VERSION });
});
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/tasks', apiLimiter, tasksRouter);
app.use('/api/analytics', apiLimiter, analyticsRouter);
app.use('/api/dropdowns', apiLimiter, dropdownsRouter);
app.use('/api/admin', apiLimiter, adminRouter);
app.use('/api/flags', apiLimiter, flagsRouter);
app.use('/api/messages', apiLimiter, messagesRouter);

app.get('/policy', apiLimiter, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'policy.html')));
app.get('/dpia',   apiLimiter, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'dpia.html')));
app.get('/help',   apiLimiter, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'help.html')));
app.get('/guide',  apiLimiter, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'guide.html')));
app.get(['/', '/index.html'], apiLimiter, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(renderIndexHtml(req));
});

// ─── Suggestion review page (token-gated, no login required) ────────────────
app.use('/suggest/review', apiLimiter, reviewRouter);

app.get('/{*path}', apiLimiter, (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(renderIndexHtml(_req));
});

// ─── Global error handler (must be after all routes) ─────────────────────────
// Catches any unhandled sync/async errors and prevents stack-trace leakage.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: express.Request, res: express.Response, _next: NextFunction) => {
  console.error('[Tasker] Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'An internal error occurred.' });
  }
});

// ─── 30-day data retention job ────────────────────────────────────────────────
function runRetention(): void {
  try {
    const r = getDb().prepare(`DELETE FROM tasks WHERE created_at<datetime('now','-30 days')`).run();
    if (r.changes > 0) console.log(`[Retention] Deleted ${r.changes} tasks >30 days`);
  } catch (e) { console.error('[Retention]', e); }
}
runRetention();
setInterval(runRetention, 24 * 60 * 60 * 1000);

// ─── Start ────────────────────────────────────────────────────────────────────
getDb();
if (useHttps) {
  if (!SSL_CERT || !SSL_KEY) {
    console.error('USE_HTTPS=true but SSL_CERT or SSL_KEY are not set. Aborting.');
    process.exit(1);
  }
  if (!fs.existsSync(SSL_CERT) || !fs.existsSync(SSL_KEY)) {
    console.error(`USE_HTTPS=true but certificate file(s) not found (SSL_CERT=${SSL_CERT}, SSL_KEY=${SSL_KEY}). Aborting.`);
    process.exit(1);
  }
  const tlsOptions = {
    cert: fs.readFileSync(SSL_CERT),
    key:  fs.readFileSync(SSL_KEY),
  };
  https.createServer(tlsOptions, app).listen(PORT, () =>
    console.log(`Tasker running on port ${PORT} (HTTPS)`),
  );
} else {
  http.createServer(app).listen(PORT, () =>
    console.log(`Tasker running on port ${PORT} (HTTP)`),
  );
}
export default app;
