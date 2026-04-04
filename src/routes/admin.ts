import { Router, Request, Response } from 'express';
import { getDb, DB_PATH, replaceDb, RESTORE_DIR, getSetting, setSetting } from '../db';
import { requireAdmin, requireAuth, validateCsrf, logEvent } from '../middleware/index';
import { generateUsername } from '../words';
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
  const eventCount = (db.prepare('SELECT COUNT(*) as c FROM events').get() as any).c;
  res.json({ userCount, pendingCount, awaitingActivationCount, eventCount });
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
    'SELECT id,username,must_change_password,is_locked,created_at FROM users WHERE is_admin=0 AND is_approved=1 AND pending_activation=0 ORDER BY username'
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
