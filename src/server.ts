import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import path from 'path';
import { getDb } from './db';
import authRouter from './routes/auth';
import tasksRouter from './routes/tasks';

const app = express();
const PORT = process.env['PORT'] || 3000;
const isProd = process.env['NODE_ENV'] === 'production';

// Initialise database
getDb();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env['SESSION_SECRET'] || 'tasker-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: isProd,
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

const staticLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

// ── CSRF protection ──────────────────────────────────────────
declare module 'express-session' {
  interface SessionData {
    userId: number;
    username: string;
    csrfToken: string;
  }
}

/** Attach a CSRF token to the session if not already present. */
function ensureCsrfToken(req: Request): string {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

/** Middleware: validate X-CSRF-Token header for mutating requests. */
function csrfProtect(req: Request, res: Response, next: NextFunction): void {
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) {
    next();
    return;
  }
  const token = req.headers['x-csrf-token'] as string | undefined;
  if (!token || !req.session.csrfToken || token !== req.session.csrfToken) {
    res.status(403).json({ error: 'Invalid or missing CSRF token.' });
    return;
  }
  next();
}

// Static files (served before session-dependent routes)
app.use(express.static(path.join(__dirname, '..', 'public')));

// GET /api/csrf-token — SPA fetches this on load to get/refresh the CSRF token
app.get('/api/csrf-token', (req: Request, res: Response) => {
  const token = ensureCsrfToken(req);
  res.json({ csrfToken: token });
});

// Apply CSRF protection to all mutating API routes
app.use('/api', csrfProtect);

// API routes
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/tasks', apiLimiter, tasksRouter);

// Serve the SPA for any unmatched route
app.get('/{*path}', staticLimiter, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Tasker server running on http://localhost:${PORT}`);
});

export default app;
