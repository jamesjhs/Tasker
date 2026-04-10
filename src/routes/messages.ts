import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { requireAuth, requireAdmin, validateCsrf, requirePasswordChange, requireActivation } from '../middleware/index';

const router = Router();

// ── User routes ───────────────────────────────────────────────────────────────

router.get('/', requireAuth, requirePasswordChange, requireActivation, (req: Request, res: Response) => {
  const s = req.session as any;
  const messages = getDb().prepare(
    'SELECT id, message, read, created_at FROM user_messages WHERE user_id=? ORDER BY created_at DESC LIMIT 50'
  ).all(s.userId);
  res.json({ messages });
});

router.post('/:id/read', requireAuth, requirePasswordChange, requireActivation, validateCsrf, (req: Request, res: Response) => {
  const s = req.session as any;
  const msgId = Number(req.params['id']);
  const msg = getDb().prepare('SELECT id FROM user_messages WHERE id=? AND user_id=?').get(msgId, s.userId);
  if (!msg) { res.status(404).json({ error: 'Message not found.' }); return; }
  getDb().prepare('UPDATE user_messages SET read=1 WHERE id=?').run(msgId);
  res.json({ success: true });
});

router.post('/read-all', requireAuth, requirePasswordChange, requireActivation, validateCsrf, (req: Request, res: Response) => {
  const s = req.session as any;
  getDb().prepare('UPDATE user_messages SET read=1 WHERE user_id=?').run(s.userId);
  res.json({ success: true });
});

// ── Admin routes ──────────────────────────────────────────────────────────────

router.post('/admin/send', requireAdmin, validateCsrf, (req: Request, res: Response) => {
  const { user_id, message } = req.body as { user_id: number; message: string };
  const clean = (message || '').trim();
  if (!clean || clean.length > 500) { res.status(400).json({ error: 'Invalid message.' }); return; }
  const db = getDb();
  if (user_id) {
    const user = db.prepare('SELECT id FROM users WHERE id=? AND is_admin=0').get(Number(user_id));
    if (!user) { res.status(404).json({ error: 'User not found.' }); return; }
    db.prepare('INSERT INTO user_messages (user_id, message) VALUES (?,?)').run(Number(user_id), clean);
  } else {
    // Broadcast to all non-admin users
    const users = db.prepare('SELECT id FROM users WHERE is_admin=0 AND is_approved=1 AND pending_activation=0').all() as { id: number }[];
    const ins = db.prepare('INSERT INTO user_messages (user_id, message) VALUES (?,?)');
    db.transaction(() => { for (const u of users) ins.run(u.id, clean); })();
  }
  res.json({ success: true });
});

export default router;
