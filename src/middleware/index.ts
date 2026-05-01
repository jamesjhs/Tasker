import { Request, Response, NextFunction } from 'express';

// ─── Session auth ─────────────────────────────────────────────────────────────
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const s = req.session as any;
  if (!s?.userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const now = Date.now();
  if (now - (s.lastActivity || 0) > 30 * 60 * 1000) {
    req.session.destroy(() => {});
    res.status(401).json({ error: 'Session expired due to inactivity' });
    return;
  }
  if (s.sessionDate && s.sessionDate !== new Date().toISOString().split('T')[0]) {
    req.session.destroy(() => {});
    res.status(401).json({ error: 'Session ended at midnight. Please log in again.' });
    return;
  }
  s.lastActivity = now;
  // Touch session to extend cookie expiration (sliding window)
  req.session.touch();
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const s = req.session as any;
  if (!s?.userId || !s?.isAdmin) { res.status(403).json({ error: 'Admin access required' }); return; }
  next();
}

export function requirePasswordChange(req: Request, res: Response, next: NextFunction): void {
  const s = req.session as any;
  const allowed = req.path.includes('/change-password') || req.path.includes('/logout');
  if (s?.mustChangePassword && !allowed) {
    res.status(403).json({ error: 'You must change your password before continuing', mustChangePassword: true });
    return;
  }
  next();
}

export function requireActivation(req: Request, res: Response, next: NextFunction): void {
  const s = req.session as any;
  const allowed = req.path.includes('/logout');
  if (s?.pendingActivation && !allowed) {
    res.status(403).json({ error: 'Your account is awaiting administrator activation', pendingActivation: true });
    return;
  }
  next();
}

// ─── CSRF ─────────────────────────────────────────────────────────────────────
export function validateCsrf(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers['x-csrf-token'] as string;
  const s = req.session as any;
  if (!token || token !== s?.csrfToken) {
    res.status(403).json({ error: 'Invalid CSRF token' });
    return;
  }
  next();
}

// ─── Event logger ─────────────────────────────────────────────────────────────
export function logEvent(type: string): void {
  try {
    const { getDb } = require('../db');
    getDb().prepare('INSERT INTO events (event_type) VALUES (?)').run(type);
  } catch { /* non-critical */ }
}
