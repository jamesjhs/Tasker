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
import xpRouter from './routes/xp';

import { version as APP_VERSION } from '../package.json';
import type { NextFunction } from 'express';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const SqliteStoreFactory = require('better-sqlite3-session-store');
const Store = SqliteStoreFactory(session);
const app = express();
app.set('trust proxy', 1);
const PORT = process.env['PORT'] || 3020;
const SESSION_SECRET = process.env['SESSION_SECRET'] || crypto.randomBytes(64).toString('hex');

// ─── SSL configuration ────────────────────────────────────────────────────────
const useHttps = process.env['USE_HTTPS'] === 'true';
const SSL_CERT = process.env['SSL_CERT'] || '';
const SSL_KEY  = process.env['SSL_KEY']  || '';

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://cdn.jsdelivr.net'],
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

// ─── Static files ─────────────────────────────────────────────────────────────
// Serve sw.js dynamically so its CACHE_NAME always reflects the current app
// version.  The SW's activate handler deletes every cache whose name doesn't
// match CACHE_NAME, so changing the name on each deploy automatically cleans
// up the previous version's cached assets — even if checkAssetVersion() never
// runs (e.g. on a first load after an update, or while offline).
const swContent = fs
  .readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8')
  .replace(/'tasker-__APP_VERSION__'/g, `'tasker-${APP_VERSION}'`);

app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(swContent);
});

app.use(express.static(path.join(__dirname, '..', 'public'), {
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
app.use('/api/xp', apiLimiter, xpRouter);

app.get('/policy', apiLimiter, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'policy.html')));
app.get('/dpia',   apiLimiter, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'dpia.html')));
app.get('/help',   apiLimiter, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'help.html')));
app.get('/guide',  apiLimiter, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'guide.html')));

// ─── Suggestion review page (token-gated, no login required) ────────────────
app.use('/suggest/review', apiLimiter, reviewRouter);

app.get('/{*path}', apiLimiter, (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
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
