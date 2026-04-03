import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { getDb } from '../db';
import { generateUsername } from '../words';
import { requireAuth, validateCsrf, logEvent } from '../middleware/index';

const router = Router();
const PASSWORD_RE = /^(?=.*[!@#$%^&*()\-_=+\[\]{};:'",.<>/?\\|`~]).{8,}$/;

router.get('/csrf-token', (req: Request, res: Response) => {
  const s = req.session as any;
  if (!s.csrfToken) s.csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ token: s.csrfToken });
});

router.post('/register', validateCsrf, async (req: Request, res: Response) => {
  const { password } = req.body as { password: string };
  if (!password || !PASSWORD_RE.test(password)) {
    res.status(400).json({ error: 'Password must be at least 8 characters and include at least one special character.' });
    return;
  }
  const db = getDb();
  const username = generateUsername();
  const hash = await bcrypt.hash(password, 12);
  try {
    db.prepare('INSERT INTO users (username,password_hash) VALUES (?,?)').run(username, hash);
    logEvent('user_registered');
    res.json({ username, message: 'Registration successful. Save your username — it cannot be recovered.' });
  } catch {
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

router.post('/login', validateCsrf, async (req: Request, res: Response) => {
  const { username, password } = req.body as { username: string; password: string };
  if (!username || !password) { res.status(400).json({ error: 'Username and password required.' }); return; }
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username) as any;
  if (!user) {
    await bcrypt.compare(password, '$2a$12$invalidhashfortimingsafety00000000000000000');
    res.status(401).json({ error: 'Invalid username or password.' });
    return;
  }
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) { res.status(401).json({ error: 'Invalid username or password.' }); return; }
  const s = req.session as any;
  s.userId = user.id;
  s.isAdmin = user.is_admin === 1;
  s.mustChangePassword = user.must_change_password === 1;
  s.lastActivity = Date.now();
  s.sessionDate = new Date().toDateString();
  s.csrfToken = crypto.randomBytes(32).toString('hex');
  logEvent('user_login');
  res.json({ success: true, isAdmin: user.is_admin === 1, mustChangePassword: user.must_change_password === 1 });
});

router.post('/logout', (req: Request, res: Response) => {
  req.session.destroy(() => res.json({ success: true }));
});

router.post('/change-password', requireAuth, validateCsrf, async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
  const s = req.session as any;
  if (!newPassword || !PASSWORD_RE.test(newPassword)) {
    res.status(400).json({ error: 'New password must be ≥8 chars with at least one special character.' });
    return;
  }
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(s.userId) as any;
  if (!s.mustChangePassword) {
    const ok = await bcrypt.compare(currentPassword || '', user.password_hash);
    if (!ok) { res.status(401).json({ error: 'Current password is incorrect.' }); return; }
  }
  const hash = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?').run(hash, s.userId);
  s.mustChangePassword = false;
  logEvent('password_changed');
  res.json({ success: true });
});

router.get('/me', requireAuth, (req: Request, res: Response) => {
  const s = req.session as any;
  const user = getDb().prepare('SELECT username,is_admin,must_change_password FROM users WHERE id=?').get(s.userId) as any;
  res.json({ username: user.username, isAdmin: user.is_admin === 1, mustChangePassword: user.must_change_password === 1 });
});

export default router;
