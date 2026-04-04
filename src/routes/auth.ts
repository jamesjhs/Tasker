import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { getDb, getSetting } from '../db';
import { generateUsername } from '../words';
import { requireAuth, validateCsrf, logEvent } from '../middleware/index';

const router = Router();
const PASSWORD_RE = /^(?=.*[!@#$%^&*()\-_=+\[\]{};:'",.<>/?\\|`~]).{8,}$/;

router.get('/csrf-token', (req: Request, res: Response) => {
  const s = req.session as any;
  if (!s.csrfToken) s.csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ token: s.csrfToken });
});

router.get('/registration-config', (_req: Request, res: Response) => {
  const selfRegistration = getSetting('self_registration') || 'admin_approved';
  const userInvite = getSetting('user_invite') || 'admin_approved';
  res.json({ selfRegistration, userInvite });
});

router.get('/stats', (_req: Request, res: Response) => {
  const db = getDb();
  const userCount = (db.prepare('SELECT COUNT(*) as c FROM users WHERE is_admin=0 AND is_approved=1 AND pending_activation=0').get() as any).c;
  const eventCount = (db.prepare('SELECT COUNT(*) as c FROM events').get() as any).c;
  res.json({ userCount, eventCount });
});

router.post('/register', validateCsrf, async (req: Request, res: Response) => {
  const selfRegistration = getSetting('self_registration') || 'admin_approved';
  if (selfRegistration === 'disabled') {
    res.status(403).json({ error: 'Self-registration is not enabled.' });
    return;
  }
  const { password } = req.body as { password: string };
  if (!password || !PASSWORD_RE.test(password)) {
    res.status(400).json({ error: 'Password must be at least 8 characters and include at least one special character.' });
    return;
  }
  const db = getDb();
  const username = generateUsername();
  const hash = await bcrypt.hash(password, 12);
  const isApproved = selfRegistration === 'auto' ? 1 : 0;
  try {
    db.prepare('INSERT INTO users (username,password_hash,is_approved) VALUES (?,?,?)').run(username, hash, isApproved);
    logEvent('user_registered');
    if (isApproved) {
      res.json({ username, message: 'Registration successful. Save your username — it cannot be recovered.' });
    } else {
      res.json({ username, pending: true, message: 'Registration submitted. Your account is awaiting administrator approval before you can log in.' });
    }
  } catch {
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

router.post('/invite', requireAuth, validateCsrf, async (req: Request, res: Response) => {
  const userInvite = getSetting('user_invite') || 'admin_approved';
  if (userInvite === 'disabled') {
    res.status(403).json({ error: 'User invitations are not enabled.' });
    return;
  }
  const db = getDb();
  const username = generateUsername();
  const TEMP_SYMBOLS = ['%', '#', '?'];
  const tempPassword = crypto.randomBytes(5).toString('hex') + TEMP_SYMBOLS[crypto.randomInt(TEMP_SYMBOLS.length)];
  const hash = await bcrypt.hash(tempPassword, 12);
  // User-invited accounts can always log in but require admin activation
  // unless the mode is 'auto' (no admin action needed)
  const pendingActivation = userInvite === 'auto' ? 0 : 1;
  try {
    db.prepare('INSERT INTO users (username,password_hash,must_change_password,is_approved,pending_activation) VALUES (?,?,1,1,?)').run(username, hash, pendingActivation);
    logEvent('user_invited');
    res.json({ username, tempPassword, pendingActivation: pendingActivation === 1, message: 'User invited. Share credentials securely.' });
  } catch {
    res.status(500).json({ error: 'Invite failed. Please try again.' });
  }
});

router.post('/login', validateCsrf, async (req: Request, res: Response) => {
  const { username, password } = req.body as { username: string; password: string };
  if (!username || !password) { res.status(400).json({ error: 'Username and password required.' }); return; }
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE LOWER(username)=LOWER(?)').get(username) as any;
  if (!user) {
    await bcrypt.compare(password, '$2a$12$invalidhashfortimingsafety00000000000000000');
    res.status(401).json({ error: 'Incorrect username or password. Please check and try again.' });
    return;
  }
  const valid = await bcrypt.compare(password, user.password_hash);
  if (user.is_approved === 0) {
    res.status(403).json({ error: 'Your account is pending administrator approval. Please check back later.' });
    return;
  }
  if (user.is_locked) {
    res.status(403).json({ error: 'This account has been locked after too many failed login attempts. Please contact an administrator to unlock it.' });
    return;
  }
  if (!valid) {
    const attempts = (user.failed_login_attempts || 0) + 1;
    const locked = attempts >= 3;
    db.prepare('UPDATE users SET failed_login_attempts=?, is_locked=? WHERE id=?').run(attempts, locked ? 1 : 0, user.id);
    const remaining = 3 - attempts;
    if (locked) {
      res.status(403).json({ error: 'Account locked after 3 failed login attempts. Please contact an administrator to unlock it.' });
    } else {
      res.status(401).json({ error: `Incorrect password. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining before account lockout.` });
    }
    return;
  }
  const s = req.session as any;
  s.userId = user.id;
  s.isAdmin = user.is_admin === 1;
  s.mustChangePassword = user.must_change_password === 1;
  s.pendingActivation = user.must_change_password === 0 && user.pending_activation === 1;
  s.lastActivity = Date.now();
  s.sessionDate = new Date().toISOString().split('T')[0];
  s.csrfToken = crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE users SET failed_login_attempts=0, is_locked=0 WHERE id=?').run(user.id);
  logEvent('user_login');
  res.json({ success: true, isAdmin: user.is_admin === 1, mustChangePassword: user.must_change_password === 1, pendingActivation: user.must_change_password === 0 && user.pending_activation === 1 });
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
  // Now that the password is changed, activation state becomes active in session
  const updated = db.prepare('SELECT pending_activation FROM users WHERE id=?').get(s.userId) as any;
  const pendingActivation = updated.pending_activation === 1;
  s.pendingActivation = pendingActivation;
  logEvent('password_changed');
  res.json({ success: true, pendingActivation });
});

router.get('/me', requireAuth, (req: Request, res: Response) => {
  const s = req.session as any;
  const user = getDb().prepare('SELECT username,is_admin,must_change_password,pending_activation FROM users WHERE id=?').get(s.userId) as any;
  const pendingActivation = user.must_change_password === 0 && user.pending_activation === 1;
  s.pendingActivation = pendingActivation;
  res.json({ username: user.username, isAdmin: user.is_admin === 1, mustChangePassword: user.must_change_password === 1, pendingActivation });
});

router.delete('/account', requireAuth, validateCsrf, async (req: Request, res: Response) => {
  const { username, password } = req.body as { username: string; password: string };
  const s = req.session as any;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=? AND is_admin=0').get(s.userId) as any;
  if (!user) { res.status(404).json({ error: 'Account not found.' }); return; }
  if (!username || username !== user.username) {
    res.status(400).json({ error: 'Username does not match. Account not deleted.' });
    return;
  }
  const valid = await bcrypt.compare(password || '', user.password_hash);
  if (!valid) { res.status(401).json({ error: 'Incorrect password. Account not deleted.' }); return; }
  db.prepare('DELETE FROM users WHERE id=?').run(user.id);
  logEvent('user_self_deleted');
  req.session.destroy(() => {});
  res.json({ success: true });
});

export default router;
