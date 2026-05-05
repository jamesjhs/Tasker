import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { getDb, getSetting } from '../db';
import { generateUsername } from '../words';
import { requireAuth, validateCsrf, logEvent, requirePasswordChange, requireActivation } from '../middleware/index';
import { sendEmail } from '../email';
import { isTurnstileEnabled, verifyTurnstileToken } from '../turnstile';

const router = Router();
const PASSWORD_RE = /^(?=.*[!@#$%^&*()\-_=+\[\]{};:'",.<>/?\\|`~]).{8,}$/;

router.get('/csrf-token', (req: Request, res: Response) => {
  const s = req.session as any;
  if (!s.csrfToken) s.csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ token: s.csrfToken });
});

router.get('/turnstile-config', (_req: Request, res: Response) => {
  const siteKey = process.env['TURNSTILE_SITE_KEY'] || '';
  if (siteKey) {
    res.json({ enabled: true, siteKey });
  } else {
    res.json({ enabled: false, siteKey: null });
  }
});

router.get('/registration-config', (_req: Request, res: Response) => {
  const selfRegistration = getSetting('self_registration') || 'admin_approved';
  const userInvite = getSetting('user_invite') || 'admin_approved';
  res.json({ selfRegistration, userInvite });
});

router.get('/stats', (_req: Request, res: Response) => {
  const db = getDb();
  const userCount = (db.prepare('SELECT COUNT(*) as c FROM users WHERE is_admin=0 AND is_approved=1 AND pending_activation=0').get() as any).c;
  const taskCount = (db.prepare('SELECT COUNT(*) as c FROM tasks WHERE status=\'completed\'').get() as any).c;
  res.json({ userCount, taskCount });
});

router.post('/register', validateCsrf, async (req: Request, res: Response) => {
  const selfRegistration = getSetting('self_registration') || 'admin_approved';
  if (selfRegistration === 'disabled') {
    res.status(403).json({ error: 'Self-registration is not enabled.' });
    return;
  }

  // Verify Turnstile CAPTCHA when enabled
  if (isTurnstileEnabled()) {
    const token = (req.body as any)['cf-turnstile-response'] || '';
    const valid = await verifyTurnstileToken(token, req.ip);
    if (!valid) {
      res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });
      return;
    }
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
  // Verify Turnstile CAPTCHA when enabled
  if (isTurnstileEnabled()) {
    const token = (req.body as any)['cf-turnstile-response'] || '';
    const valid = await verifyTurnstileToken(token, req.ip);
    if (!valid) {
      res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });
      return;
    }
  }

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

  // Reset failed attempts on successful credential check
  db.prepare('UPDATE users SET failed_login_attempts=0, is_locked=0 WHERE id=?').run(user.id);

  // ── 2FA check for admin accounts ──────────────────────────────────────────
  if (user.is_admin === 1 && user.mfa_enabled === 1) {
    const code = String(crypto.randomInt(100000, 999999));
    const expiry = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Regenerate session to prevent session fixation before storing MFA state
    await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    const s = req.session as any;
    s.mfaPendingUserId = user.id;
    s.mfaCode = code;
    s.mfaCodeExpiry = expiry;
    s.mfaAttempts = 0;
    s.csrfToken = crypto.randomBytes(32).toString('hex');

    const adminEmail = getSetting('smtp_to') || '';
    const backupEmail = user.mfa_backup_email || '';
    const recipients = [adminEmail, backupEmail].filter(Boolean).join(', ');
    if (!recipients) {
      res.status(503).json({ error: '2FA is enabled but no admin email address is configured. Configure SMTP settings first.' });
      return;
    }
    try {
      const { sendEmailTo } = await import('../email');
      await sendEmailTo(
        recipients,
        'Tasker Admin Login — Verification Code',
        `Your Tasker admin login verification code is:\n\n  ${code}\n\nThis code expires in 10 minutes. Do not share it with anyone.`,
      );
    } catch (e: any) {
      console.error('[Tasker] 2FA email error:', e);
      res.status(503).json({ error: 'Could not send 2FA code (SMTP error). Please contact the administrator.' });
      return;
    }
    res.json({ requires2fa: true });
    return;
  }

  // Regenerate session to prevent session fixation
  await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  const s = req.session as any;
  s.userId = user.id;
  s.isAdmin = user.is_admin === 1;
  s.mustChangePassword = user.must_change_password === 1;
  s.pendingActivation = user.must_change_password === 0 && user.pending_activation === 1;
  s.lastActivity = Date.now();
  s.sessionDate = new Date().toISOString().split('T')[0];
  s.csrfToken = crypto.randomBytes(32).toString('hex');
  logEvent('user_login');
  const groupInfo = db.prepare(
    'SELECT u.user_group_id, ug.name as user_group_name FROM users u LEFT JOIN user_groups ug ON ug.id=u.user_group_id WHERE u.id=?'
  ).get(user.id) as { user_group_id: number | null; user_group_name: string | null } | undefined;
  res.json({
    success: true,
    isAdmin: user.is_admin === 1,
    mustChangePassword: user.must_change_password === 1,
    pendingActivation: user.must_change_password === 0 && user.pending_activation === 1,
    userGroupId: groupInfo?.user_group_id ?? null,
    userGroupName: groupInfo?.user_group_name ?? null,
  });
});

router.post('/verify-2fa', validateCsrf, async (req: Request, res: Response) => {
  const s = req.session as any;
  if (!s.mfaPendingUserId || !s.mfaCode) {
    res.status(400).json({ error: 'No pending 2FA session. Please log in again.' });
    return;
  }
  if (Date.now() > s.mfaCodeExpiry) {
    delete s.mfaPendingUserId; delete s.mfaCode; delete s.mfaCodeExpiry; delete s.mfaAttempts;
    res.status(401).json({ error: 'Verification code has expired. Please log in again.' });
    return;
  }
  const { code } = req.body as { code: string };
  s.mfaAttempts = (s.mfaAttempts || 0) + 1;

  // Normalise to exactly 6 bytes before constant-time comparison to avoid both
  // memory-exhaustion from untrusted-length input and timing oracle via length mismatch.
  const trimmedInput = (code || '').trim().slice(0, 16);
  const inputNorm   = trimmedInput.slice(0, 6).padEnd(6, '\x00');
  const expectedNorm = (s.mfaCode || '').slice(0, 6).padEnd(6, '\x00');
  const codeMatch = crypto.timingSafeEqual(Buffer.from(inputNorm), Buffer.from(expectedNorm))
    && trimmedInput.length === 6;

  if (!codeMatch) {
    if (s.mfaAttempts >= 5) {
      delete s.mfaPendingUserId; delete s.mfaCode; delete s.mfaCodeExpiry; delete s.mfaAttempts;
      res.status(401).json({ error: 'Too many incorrect attempts. Please log in again.' });
      return;
    }
    const remaining = 5 - s.mfaAttempts;
    res.status(401).json({ error: `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` });
    return;
  }

  const db = getDb();
  const pendingUserId = s.mfaPendingUserId;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(pendingUserId) as any;
  if (!user) {
    delete s.mfaPendingUserId; delete s.mfaCode; delete s.mfaCodeExpiry; delete s.mfaAttempts;
    res.status(404).json({ error: 'User not found.' }); return;
  }

  // Regenerate session to prevent session fixation after successful 2FA
  await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  const newS = req.session as any;
  newS.userId = user.id;
  newS.isAdmin = user.is_admin === 1;
  newS.mustChangePassword = user.must_change_password === 1;
  newS.pendingActivation = user.must_change_password === 0 && user.pending_activation === 1;
  newS.lastActivity = Date.now();
  newS.sessionDate = new Date().toISOString().split('T')[0];
  newS.csrfToken = crypto.randomBytes(32).toString('hex');
  logEvent('user_login');
  const groupInfo = db.prepare(
    'SELECT u.user_group_id, ug.name as user_group_name FROM users u LEFT JOIN user_groups ug ON ug.id=u.user_group_id WHERE u.id=?'
  ).get(user.id) as { user_group_id: number | null; user_group_name: string | null } | undefined;
  res.json({
    success: true,
    isAdmin: user.is_admin === 1,
    mustChangePassword: user.must_change_password === 1,
    pendingActivation: user.must_change_password === 0 && user.pending_activation === 1,
    userGroupId: groupInfo?.user_group_id ?? null,
    userGroupName: groupInfo?.user_group_name ?? null,
  });
});

router.post('/resend-2fa', validateCsrf, async (req: Request, res: Response) => {
  const s = req.session as any;
  if (!s.mfaPendingUserId) {
    res.status(400).json({ error: 'No pending 2FA session. Please log in again.' });
    return;
  }
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(s.mfaPendingUserId) as any;
  if (!user) { res.status(404).json({ error: 'User not found.' }); return; }

  const code = String(crypto.randomInt(100000, 999999));
  s.mfaCode = code;
  s.mfaCodeExpiry = Date.now() + 10 * 60 * 1000;
  s.mfaAttempts = 0;

  const adminEmail = getSetting('smtp_to') || '';
  const backupEmail = user.mfa_backup_email || '';
  const recipients = [adminEmail, backupEmail].filter(Boolean).join(', ');
  if (!recipients) {
    res.status(503).json({ error: 'No admin email address configured.' });
    return;
  }
  try {
    const { sendEmailTo } = await import('../email');
    await sendEmailTo(
      recipients,
      'Tasker Admin Login — Verification Code (resent)',
      `Your Tasker admin login verification code is:\n\n  ${code}\n\nThis code expires in 10 minutes. Do not share it with anyone.`,
    );
    res.json({ success: true });
  } catch (e: any) {
    console.error('[Tasker] Resend 2FA email error:', e);
    res.status(503).json({ error: 'Could not resend code (SMTP error). Please contact the administrator.' });
  }
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
  const user = getDb().prepare(
    `SELECT u.username, u.is_admin, u.must_change_password, u.pending_activation,
            u.user_group_id, ug.name as user_group_name
     FROM users u LEFT JOIN user_groups ug ON ug.id=u.user_group_id
     WHERE u.id=?`
  ).get(s.userId) as any;
  const pendingActivation = user.must_change_password === 0 && user.pending_activation === 1;
  s.pendingActivation = pendingActivation;
  res.json({
    username: user.username,
    isAdmin: user.is_admin === 1,
    mustChangePassword: user.must_change_password === 1,
    pendingActivation,
    userGroupId: user.user_group_id ?? null,
    userGroupName: user.user_group_name ?? null,
  });
});

router.get('/user-groups', requireAuth, (_req: Request, res: Response) => {
  const groups = getDb().prepare('SELECT id, name FROM user_groups WHERE is_approved=1 ORDER BY name').all();
  res.json({ groups });
});

router.post('/propose-group', requireAuth, validateCsrf, requirePasswordChange, requireActivation, (req: Request, res: Response) => {
  const { name } = req.body as { name: string };
  const clean = (name || '').trim();
  if (!clean || clean.length > 100) { res.status(400).json({ error: 'Invalid group name.' }); return; }
  const db = getDb();
  const existing = db.prepare('SELECT id, is_approved FROM user_groups WHERE name=?').get(clean) as any;
  if (existing) {
    res.json({ message: existing.is_approved ? 'A group with that name already exists.' : 'That group name is already pending review.' });
    return;
  }
  db.prepare('INSERT INTO user_groups (name, is_approved) VALUES (?,0)').run(clean);
  res.json({ message: 'Group suggestion submitted for admin review.' });
});

router.post('/set-group', requireAuth, validateCsrf, (req: Request, res: Response) => {
  const s = req.session as any;
  const { groupId } = req.body as { groupId: number | null };
  const db = getDb();
  if (groupId !== null) {
    const group = db.prepare('SELECT id FROM user_groups WHERE id=? AND is_approved=1').get(groupId);
    if (!group) { res.status(400).json({ error: 'User group not found.' }); return; }
  }
  db.transaction(() => {
    db.prepare('UPDATE users SET user_group_id=? WHERE id=?').run(groupId ?? null, s.userId);
    // Seed personal options from group defaults whenever group changes
    if (groupId !== null) {
      db.prepare('DELETE FROM user_dropdown_options WHERE user_id=?').run(s.userId);
      db.prepare(
        'INSERT INTO user_dropdown_options (user_id, dropdown_option_id) SELECT ?, dropdown_option_id FROM group_dropdown_options WHERE group_id=?'
      ).run(s.userId, groupId);
    }
  })();
  logEvent('user_group_set');
  res.json({ success: true });
});

// Return all approved options with personal assignment state
router.get('/my-options', requireAuth, requirePasswordChange, requireActivation, (req: Request, res: Response) => {
  const s = req.session as any;
  const options = getDb().prepare(
    `SELECT do.id, do.field_name, do.value,
            CASE WHEN udo.user_id IS NOT NULL THEN 1 ELSE 0 END as assigned
     FROM dropdown_options do
     LEFT JOIN user_dropdown_options udo ON udo.dropdown_option_id=do.id AND udo.user_id=?
     WHERE do.approved=1
     ORDER BY do.field_name, do.value`
  ).all(s.userId);
  res.json({ options });
});

// Replace the user's entire personal option list
router.put('/my-options', requireAuth, requirePasswordChange, requireActivation, validateCsrf, (req: Request, res: Response) => {
  const s = req.session as any;
  const { option_ids } = req.body as { option_ids: number[] };
  if (!Array.isArray(option_ids)) { res.status(400).json({ error: 'option_ids must be an array.' }); return; }
  const db = getDb();
  const numericIds = option_ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
  // Validate all IDs are approved dropdown options; silently discard any that are not
  let approvedIds: Set<number> = new Set();
  if (numericIds.length > 0) {
    const placeholders = numericIds.map(() => '?').join(',');
    approvedIds = new Set(
      (db.prepare(`SELECT id FROM dropdown_options WHERE id IN (${placeholders}) AND approved=1`).all(...numericIds) as { id: number }[])
        .map(r => r.id)
    );
  }
  db.transaction(() => {
    db.prepare('DELETE FROM user_dropdown_options WHERE user_id=?').run(s.userId);
    const ins = db.prepare('INSERT OR IGNORE INTO user_dropdown_options (user_id, dropdown_option_id) VALUES (?,?)');
    for (const optId of numericIds) {
      if (approvedIds.has(optId)) ins.run(s.userId, optId);
    }
  })();
  logEvent('user_options_updated');
  res.json({ success: true });
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

// ── Notices (public, authenticated users) ─────────────────────────────────────

router.get('/notices', requireAuth, requirePasswordChange, requireActivation, (_req: Request, res: Response) => {
  const notices = getDb().prepare(
    'SELECT id, message, created_at FROM notices WHERE active=1 ORDER BY created_at DESC'
  ).all();
  res.json({ notices });
});

// ── Feedback / "Send suggestion to developers" ────────────────────────────────
// CSRF: X-CSRF-Token header required (mutating). No username stored or sent.

router.post('/feedback', requireAuth, requirePasswordChange, requireActivation, validateCsrf, async (req: Request, res: Response) => {
  const { message } = req.body as { message: string };
  const clean = (message || '').trim();
  if (!clean || clean.length > 1000) { res.status(400).json({ error: 'Message must be 1–1000 characters.' }); return; }
  try {
    await sendEmail(
      'Tasker: Feedback / suggestion from a user',
      `A user has submitted a suggestion or piece of feedback:\n\n"${clean}"\n\n(No identifying information is attached to this message.)`,
    );
    res.json({ message: 'Your feedback has been sent. Thank you!' });
  } catch (e: any) {
    console.error('[Tasker] Feedback email error:', e);
    res.status(503).json({ error: 'Could not send feedback (SMTP error). Please contact the administrator.' });
  }
});

export default router;
