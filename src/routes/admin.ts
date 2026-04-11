import { Router, Request, Response } from 'express';
import { getDb, DB_PATH, replaceDb, RESTORE_DIR, getSetting, setSetting } from '../db';
import { requireAdmin, requireAuth, validateCsrf, logEvent } from '../middleware/index';
import { generateUsername } from '../words';
import { encryptField } from '../encrypt';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = Router();
router.use(requireAuth, requireAdmin);

const upload = multer({ dest: RESTORE_DIR, limits: { fileSize: 100 * 1024 * 1024 } });
const VALID_MODES = ['disabled', 'admin_approved', 'auto'];

router.get('/stats', (_req: Request, res: Response) => {
  const db = getDb();
  const userCount = (db.prepare('SELECT COUNT(*) as c FROM users WHERE is_admin=0 AND is_approved=1 AND pending_activation=0').get() as any).c;
  const pendingCount = (db.prepare('SELECT COUNT(*) as c FROM users WHERE is_admin=0 AND is_approved=0').get() as any).c;
  const awaitingActivationCount = (db.prepare('SELECT COUNT(*) as c FROM users WHERE is_admin=0 AND is_approved=1 AND pending_activation=1').get() as any).c;
  const taskCount = (db.prepare('SELECT COUNT(*) as c FROM tasks WHERE status=\'completed\'').get() as any).c;
  const pendingGroupCount = (db.prepare('SELECT COUNT(*) as c FROM user_groups WHERE is_approved=0').get() as any).c;
  const pendingProposalCount = (db.prepare('SELECT COUNT(*) as c FROM dropdown_proposals').get() as any).c;
  res.json({ userCount, pendingCount, awaitingActivationCount, taskCount, pendingGroupCount, pendingProposalCount });
});

router.get('/settings', (_req: Request, res: Response) => {
  const selfRegistration = getSetting('self_registration') || 'admin_approved';
  const userInvite = getSetting('user_invite') || 'admin_approved';
  res.json({ selfRegistration, userInvite });
});

router.post('/settings', validateCsrf, (req: Request, res: Response) => {
  const { selfRegistration, userInvite } = req.body as { selfRegistration: string; userInvite: string };
  if (!VALID_MODES.includes(selfRegistration) || !VALID_MODES.includes(userInvite)) {
    res.status(400).json({ error: 'Invalid setting value.' });
    return;
  }
  setSetting('self_registration', selfRegistration);
  setSetting('user_invite', userInvite);
  logEvent('admin_settings_changed');
  res.json({ success: true });
});

router.get('/users', (_req: Request, res: Response) => {
  const users = getDb().prepare(
    `SELECT id, username, must_change_password, is_locked, created_at
     FROM users
     WHERE is_admin=0 AND is_approved=1 AND pending_activation=0 ORDER BY username`
  ).all();
  res.json({ users });
});

router.get('/pending-users', (_req: Request, res: Response) => {
  const users = getDb().prepare(
    'SELECT id,username,must_change_password,created_at FROM users WHERE is_admin=0 AND is_approved=0 ORDER BY created_at'
  ).all();
  res.json({ users });
});

router.get('/awaiting-activation', (_req: Request, res: Response) => {
  const users = getDb().prepare(
    'SELECT id,username,must_change_password,created_at FROM users WHERE is_admin=0 AND is_approved=1 AND pending_activation=1 ORDER BY created_at'
  ).all();
  res.json({ users });
});

router.post('/users', validateCsrf, async (_req: Request, res: Response) => {
  const db = getDb();
  const username = generateUsername();
  const tempPassword = crypto.randomBytes(5).toString('hex') + '!';
  const hash = await bcrypt.hash(tempPassword, 12);
  db.prepare('INSERT INTO users (username,password_hash,must_change_password) VALUES (?,?,1)').run(username, hash);
  logEvent('admin_user_created');
  res.json({ username, tempPassword, message: 'User created. Share credentials securely.' });
});

router.post('/users/:id/reset-password', validateCsrf, async (req: Request, res: Response) => {
  const userId = Number(req.params['id']);
  const user = getDb().prepare('SELECT id FROM users WHERE id=? AND is_admin=0').get(userId);
  if (!user) { res.status(404).json({ error: 'User not found.' }); return; }
  const tempPassword = crypto.randomBytes(5).toString('hex') + '!';
  const hash = await bcrypt.hash(tempPassword, 12);
  getDb().prepare('UPDATE users SET password_hash=?,must_change_password=1,failed_login_attempts=0,is_locked=0 WHERE id=?').run(hash, userId);
  logEvent('admin_password_reset');
  res.json({ tempPassword });
});

router.post('/users/:id/unlock', validateCsrf, (req: Request, res: Response) => {
  const userId = Number(req.params['id']);
  const user = getDb().prepare('SELECT id FROM users WHERE id=? AND is_admin=0').get(userId);
  if (!user) { res.status(404).json({ error: 'User not found.' }); return; }
  getDb().prepare('UPDATE users SET failed_login_attempts=0, is_locked=0 WHERE id=?').run(userId);
  logEvent('admin_user_unlocked');
  res.json({ success: true });
});

router.delete('/users/:id', validateCsrf, (req: Request, res: Response) => {
  const userId = Number(req.params['id']);
  const user = getDb().prepare('SELECT id FROM users WHERE id=? AND is_admin=0').get(userId);
  if (!user) { res.status(404).json({ error: 'User not found.' }); return; }
  getDb().prepare('DELETE FROM users WHERE id=?').run(userId);
  logEvent('admin_user_deleted');
  res.json({ success: true });
});

router.post('/users/:id/approve', validateCsrf, (req: Request, res: Response) => {
  const userId = Number(req.params['id']);
  const user = getDb().prepare('SELECT id FROM users WHERE id=? AND is_admin=0 AND is_approved=0').get(userId);
  if (!user) { res.status(404).json({ error: 'Pending user not found.' }); return; }
  getDb().prepare('UPDATE users SET is_approved=1 WHERE id=?').run(userId);
  logEvent('admin_user_approved');
  res.json({ success: true });
});

router.post('/users/:id/activate', validateCsrf, (req: Request, res: Response) => {
  const userId = Number(req.params['id']);
  const user = getDb().prepare('SELECT id FROM users WHERE id=? AND is_admin=0 AND is_approved=1 AND pending_activation=1').get(userId);
  if (!user) { res.status(404).json({ error: 'User awaiting activation not found.' }); return; }
  getDb().prepare('UPDATE users SET pending_activation=0 WHERE id=?').run(userId);
  logEvent('admin_user_activated');
  res.json({ success: true });
});

// ── User Groups ───────────────────────────────────────────────────────────────

router.get('/user-groups', (_req: Request, res: Response) => {
  const db = getDb();
  const groups = db.prepare(
    `SELECT ug.id, ug.name, ug.created_at,
            COUNT(DISTINCT u.id) as user_count
     FROM user_groups ug
     LEFT JOIN users u ON u.user_group_id = ug.id AND u.is_admin=0
     WHERE ug.is_approved=1
     GROUP BY ug.id ORDER BY ug.name`
  ).all();
  res.json({ groups });
});

router.post('/user-groups', validateCsrf, (req: Request, res: Response) => {
  const { name } = req.body as { name: string };
  const clean = (name || '').trim();
  if (!clean || clean.length > 80) { res.status(400).json({ error: 'Invalid group name.' }); return; }
  const db = getDb();
  try {
    const result = db.prepare('INSERT INTO user_groups (name) VALUES (?)').run(clean);
    const newGroupId = result.lastInsertRowid as number;
    // Seed new group with all currently approved dropdown options
    db.prepare(
      'INSERT OR IGNORE INTO group_dropdown_options (group_id, dropdown_option_id) SELECT ?,id FROM dropdown_options WHERE approved=1'
    ).run(newGroupId);
    logEvent('admin_user_group_created');
    res.json({ success: true, id: newGroupId, name: clean });
  } catch {
    res.status(409).json({ error: 'A group with that name already exists.' });
  }
});

router.put('/user-groups/:id', validateCsrf, (req: Request, res: Response) => {
  const groupId = Number(req.params['id']);
  const { name } = req.body as { name: string };
  const clean = (name || '').trim();
  if (!clean || clean.length > 80) { res.status(400).json({ error: 'Invalid group name.' }); return; }
  const db = getDb();
  const group = db.prepare('SELECT id FROM user_groups WHERE id=?').get(groupId);
  if (!group) { res.status(404).json({ error: 'Group not found.' }); return; }
  try {
    db.prepare('UPDATE user_groups SET name=? WHERE id=?').run(clean, groupId);
    logEvent('admin_user_group_renamed');
    res.json({ success: true });
  } catch {
    res.status(409).json({ error: 'A group with that name already exists.' });
  }
});

router.delete('/user-groups/:id', validateCsrf, (req: Request, res: Response) => {
  const groupId = Number(req.params['id']);
  const db = getDb();
  const group = db.prepare('SELECT id FROM user_groups WHERE id=?').get(groupId);
  if (!group) { res.status(404).json({ error: 'Group not found.' }); return; }
  // Remove group reference from users (set to NULL) — CASCADE handles group_dropdown_options
  db.prepare('UPDATE users SET user_group_id=NULL WHERE user_group_id=?').run(groupId);
  db.prepare('DELETE FROM user_groups WHERE id=?').run(groupId);
  logEvent('admin_user_group_deleted');
  res.json({ success: true });
});

router.get('/user-groups/:id/dropdowns', (req: Request, res: Response) => {
  const groupId = Number(req.params['id']);
  const db = getDb();
  const group = db.prepare('SELECT id,name FROM user_groups WHERE id=?').get(groupId) as any;
  if (!group) { res.status(404).json({ error: 'Group not found.' }); return; }
  // Return all approved options, flagging which ones are assigned to this group
  const options = db.prepare(
    `SELECT do.id, do.field_name, do.value,
            CASE WHEN gdo.group_id IS NOT NULL THEN 1 ELSE 0 END as assigned
     FROM dropdown_options do
     LEFT JOIN group_dropdown_options gdo ON gdo.dropdown_option_id=do.id AND gdo.group_id=?
     WHERE do.approved=1
     ORDER BY do.field_name, do.value`
  ).all(groupId);
  res.json({ group, options });
});

router.put('/user-groups/:id/dropdowns', validateCsrf, (req: Request, res: Response) => {
  const groupId = Number(req.params['id']);
  const { option_ids } = req.body as { option_ids: number[] };
  const db = getDb();
  const group = db.prepare('SELECT id FROM user_groups WHERE id=?').get(groupId);
  if (!group) { res.status(404).json({ error: 'Group not found.' }); return; }
  if (!Array.isArray(option_ids)) { res.status(400).json({ error: 'option_ids must be an array.' }); return; }
  const update = db.transaction(() => {
    db.prepare('DELETE FROM group_dropdown_options WHERE group_id=?').run(groupId);
    const ins = db.prepare('INSERT OR IGNORE INTO group_dropdown_options (group_id, dropdown_option_id) VALUES (?,?)');
    for (const optId of option_ids) {
      ins.run(groupId, Number(optId));
    }
  });
  update();
  logEvent('admin_group_dropdowns_updated');
  res.json({ success: true });
});

// ── Pending Group Proposals ───────────────────────────────────────────────────

router.get('/pending-groups', (_req: Request, res: Response) => {
  const groups = getDb().prepare(
    'SELECT id, name, created_at FROM user_groups WHERE is_approved=0 ORDER BY created_at'
  ).all();
  res.json({ groups });
});

router.post('/pending-groups/:id/approve', validateCsrf, (req: Request, res: Response) => {
  const groupId = Number(req.params['id']);
  const db = getDb();
  const group = db.prepare('SELECT id FROM user_groups WHERE id=? AND is_approved=0').get(groupId);
  if (!group) { res.status(404).json({ error: 'Pending group not found.' }); return; }
  db.transaction(() => {
    db.prepare('UPDATE user_groups SET is_approved=1 WHERE id=?').run(groupId);
    // Seed the newly approved group with all currently approved dropdown options
    db.prepare(
      'INSERT OR IGNORE INTO group_dropdown_options (group_id, dropdown_option_id) SELECT ?,id FROM dropdown_options WHERE approved=1'
    ).run(groupId);
  })();
  logEvent('admin_group_proposal_approved');
  res.json({ success: true });
});

router.delete('/pending-groups/:id', validateCsrf, (req: Request, res: Response) => {
  const groupId = Number(req.params['id']);
  const group = getDb().prepare('SELECT id FROM user_groups WHERE id=? AND is_approved=0').get(groupId);
  if (!group) { res.status(404).json({ error: 'Pending group not found.' }); return; }
  getDb().prepare('DELETE FROM user_groups WHERE id=?').run(groupId);
  logEvent('admin_group_proposal_rejected');
  res.json({ success: true });
});

// ── SMTP Settings ─────────────────────────────────────────────────────────────

router.get('/smtp', (_req: Request, res: Response) => {
  res.json({
    host:   getSetting('smtp_host')   || '',
    port:   getSetting('smtp_port')   || '587',
    secure: getSetting('smtp_secure') || 'false',
    user:   getSetting('smtp_user')   || '',
    // Never return the password; just indicate whether one is set
    hasPass: !!(getSetting('smtp_pass')),
    from:   getSetting('smtp_from')   || '',
    to:     getSetting('smtp_to')     || '',
  });
});

router.post('/smtp', validateCsrf, (req: Request, res: Response) => {
  const { host, port, secure, user, pass, from, to } = req.body as {
    host: string; port: string; secure: string; user: string; pass?: string; from: string; to: string;
  };
  if (!host || !to) { res.status(400).json({ error: 'SMTP host and recipient address are required.' }); return; }
  const portNum = Number(port || 587);
  if (isNaN(portNum) || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    res.status(400).json({ error: 'SMTP port must be an integer between 1 and 65535.' }); return;
  }
  setSetting('smtp_host',   (host || '').trim());
  setSetting('smtp_port',   (port || '587').trim());
  setSetting('smtp_secure', secure === 'true' ? 'true' : 'false');
  setSetting('smtp_user',   (user || '').trim());
  if (pass !== undefined && pass !== '') {
    setSetting('smtp_pass', encryptField(pass) || '');
  }
  setSetting('smtp_from', (from || '').trim());
  setSetting('smtp_to',   (to || '').trim());
  logEvent('admin_smtp_settings_changed');
  res.json({ success: true });
});

router.post('/smtp/test', validateCsrf, async (_req: Request, res: Response) => {
  try {
    const { sendEmail } = await import('../email');
    await sendEmail('Tasker SMTP test', 'This is a test email from Tasker confirming your SMTP settings are working correctly.');
    res.json({ success: true });
  } catch (e: any) {
    res.status(503).json({ error: e?.message || 'SMTP test failed.' });
  }
});

// ── Notices ───────────────────────────────────────────────────────────────────

router.get('/notices', (_req: Request, res: Response) => {
  const notices = getDb().prepare(
    'SELECT id, message, active, created_at, updated_at FROM notices ORDER BY created_at DESC'
  ).all();
  res.json({ notices });
});

router.post('/notices', validateCsrf, (req: Request, res: Response) => {
  const { message } = req.body as { message: string };
  const clean = (message || '').trim();
  if (!clean || clean.length > 1000) { res.status(400).json({ error: 'Invalid notice message.' }); return; }
  const result = getDb().prepare('INSERT INTO notices (message, active) VALUES (?,1)').run(clean);
  logEvent('admin_notice_created');
  res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/notices/:id', validateCsrf, (req: Request, res: Response) => {
  const id = Number(req.params['id']);
  const { message, active } = req.body as { message?: string; active?: boolean };
  const db = getDb();
  const notice = db.prepare('SELECT id FROM notices WHERE id=?').get(id);
  if (!notice) { res.status(404).json({ error: 'Notice not found.' }); return; }
  if (message !== undefined) {
    const clean = (message || '').trim();
    if (!clean || clean.length > 1000) { res.status(400).json({ error: 'Invalid notice message.' }); return; }
    db.prepare(`UPDATE notices SET message=?, updated_at=datetime('now') WHERE id=?`).run(clean, id);
  }
  if (active !== undefined) {
    db.prepare(`UPDATE notices SET active=?, updated_at=datetime('now') WHERE id=?`).run(active ? 1 : 0, id);
  }
  logEvent('admin_notice_updated');
  res.json({ success: true });
});

router.delete('/notices/:id', validateCsrf, (req: Request, res: Response) => {
  getDb().prepare('DELETE FROM notices WHERE id=?').run(Number(req.params['id']));
  logEvent('admin_notice_deleted');
  res.json({ success: true });
});

// ── Dropdown Proposals (metadata only — no free text) ─────────────────────────

router.get('/dropdown-proposals', (_req: Request, res: Response) => {
  const proposals = getDb().prepare(
    `SELECT dp.id, dp.field_name, dp.review_token, dp.created_at
     FROM dropdown_proposals dp
     ORDER BY dp.created_at DESC`
  ).all();
  res.json({ proposals });
});

router.delete('/dropdown-proposals/:id', validateCsrf, (req: Request, res: Response) => {
  getDb().prepare('DELETE FROM dropdown_proposals WHERE id=?').run(Number(req.params['id']));
  res.json({ success: true });
});

router.get('/backup', (_req: Request, res: Response) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Disposition', `attachment; filename="tasker-backup-${ts}.db"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(DB_PATH);
});

router.post('/restore', validateCsrf, upload.single('db'), (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'No file uploaded.' }); return; }
  // Resolve and validate the uploaded path is within the allowed restore directory
  const uploadedPath = path.resolve(RESTORE_DIR, path.basename(req.file.path));
  const allowedDir = path.resolve(RESTORE_DIR);
  if (!uploadedPath.startsWith(allowedDir + path.sep)) {
    res.status(400).json({ error: 'Invalid upload path.' });
    return;
  }
  try {
    replaceDb(uploadedPath);
    fs.unlinkSync(uploadedPath);
    logEvent('admin_db_restored');
    res.json({ success: true, message: 'Database restored successfully.' });
  } catch (e) {
    try { fs.unlinkSync(uploadedPath); } catch { /* ignore */ }
    res.status(500).json({ error: 'Restore failed.' });
  }
});

export default router;
