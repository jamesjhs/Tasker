import { Request, Response, NextFunction } from 'express';

// ─── NHS network block ────────────────────────────────────────────────────────
const NHS_IP_PREFIXES = ['155.190.', '194.72.', '212.58.', '80.111.', '195.96.', '193.240.'];
const NHS_DOMAINS = ['.nhs.net', '.nhs.uk', '.nhs.scot', '.wales.nhs.uk'];

export function nhsNetworkBlock(req: Request, res: Response, next: NextFunction): void {
  const ip = ((req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '')
    .split(',')[0].trim();
  const ref = ((req.headers['referer'] || req.headers['origin'] || '') as string).toLowerCase();
  if (
    NHS_IP_PREFIXES.some(p => ip.startsWith(p)) ||
    NHS_DOMAINS.some(d => ref.includes(d))
  ) {
    res.status(403).json({
      error: 'Access from NHS networks is not permitted. Please use a personal device on a personal network.',
    });
    return;
  }
  next();
}

// ─── Mobile-only enforcement ──────────────────────────────────────────────────
const STATIC_EXT = /\.(js|css|png|ico|json|webp|svg|woff2?|map|html)$/i;

export function mobileOnly(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/api/') || req.path === '/policy' || req.path === '/help' || STATIC_EXT.test(req.path)) return next();
  const ua = req.headers['user-agent'] || '';
  if (!/Mobile|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
    res.status(200).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Tasker — Mobile Only</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:60px auto;padding:20px;text-align:center;background:#f5f5f5}
.box{background:#fff;border-radius:12px;padding:30px;box-shadow:0 2px 12px rgba(0,0,0,.1)}
h1{color:#1a56db}code{background:#eee;padding:8px 12px;border-radius:6px;display:block;margin:16px 0;word-break:break-all}
p{line-height:1.6}</style></head>
<body><div class="box"><h1>📱 Tasker</h1>
<p>This application is available on <strong>mobile devices only</strong>.</p>
<p>Open this URL on your personal mobile phone:</p>
<code>${req.protocol}://${req.get('host')}/</code>
<p style="font-size:.85em;color:#666;margin-top:24px">This restriction protects anonymity and data privacy.</p>
</div></body></html>`);
    return;
  }
  next();
}

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
  if (s.sessionDate && s.sessionDate !== new Date().toDateString()) {
    req.session.destroy(() => {});
    res.status(401).json({ error: 'Session ended at midnight. Please log in again.' });
    return;
  }
  s.lastActivity = now;
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
