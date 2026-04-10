import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { requireAuth, requireAdmin, validateCsrf, requirePasswordChange, requireActivation } from '../middleware/index';
import { sendEmail } from '../email';

const router = Router();

// ── User routes ───────────────────────────────────────────────────────────────

router.get('/', requireAuth, requirePasswordChange, requireActivation, (_req: Request, res: Response) => {
  const opts = (getDb().prepare(
    'SELECT id, value FROM task_flag_options WHERE approved=1 ORDER BY value'
  ).all() as { id: number; value: string }[]);
  res.json({ options: opts });
});

router.post('/propose', requireAuth, requirePasswordChange, requireActivation, validateCsrf, async (req: Request, res: Response) => {
  const s = req.session as any;
  const { value } = req.body as { value: string };
  const clean = (value || '').trim();
  if (!clean || clean.length > 100) { res.status(400).json({ error: 'Invalid value.' }); return; }

  const existing = getDb().prepare('SELECT id FROM task_flag_options WHERE value=?').get(clean);
  if (existing) { res.json({ message: 'This flag option already exists.' }); return; }

  const username = (getDb().prepare('SELECT username FROM users WHERE id=?').get(s.userId) as any)?.username || 'Unknown';
  try {
    await sendEmail(
      'Tasker: New task flag suggestion',
      `User "${username}" has suggested a new task flag option:\n\n"${clean}"\n\nPlease log in to the Tasker admin panel to review and add this option if appropriate.`,
    );
    res.json({ message: 'Your suggestion has been sent to the administrator.' });
  } catch (e: any) {
    res.status(503).json({ error: `Could not send suggestion: ${e?.message || 'SMTP error'}` });
  }
});

// ── Admin routes ──────────────────────────────────────────────────────────────

router.get('/admin/all', requireAdmin, (_req: Request, res: Response) => {
  const opts = getDb().prepare(
    'SELECT id, value, approved, created_at FROM task_flag_options ORDER BY approved DESC, value'
  ).all();
  res.json({ options: opts });
});

router.post('/admin', requireAdmin, validateCsrf, (req: Request, res: Response) => {
  const { value } = req.body as { value: string };
  const clean = (value || '').trim();
  if (!clean || clean.length > 100) { res.status(400).json({ error: 'Invalid value.' }); return; }
  try {
    const result = getDb().prepare('INSERT OR IGNORE INTO task_flag_options (value, approved) VALUES (?,1)').run(clean);
    if (result.changes === 0) { res.status(409).json({ error: 'Flag option already exists.' }); return; }
    res.json({ success: true, id: result.lastInsertRowid });
  } catch {
    res.status(409).json({ error: 'Flag option already exists.' });
  }
});

router.put('/admin/:id', requireAdmin, validateCsrf, (req: Request, res: Response) => {
  const optId = Number(req.params['id']);
  const { value } = req.body as { value: string };
  const clean = (value || '').trim();
  if (!clean || clean.length > 100) { res.status(400).json({ error: 'Invalid value.' }); return; }
  const db = getDb();
  const opt = db.prepare('SELECT id FROM task_flag_options WHERE id=?').get(optId);
  if (!opt) { res.status(404).json({ error: 'Flag option not found.' }); return; }
  const conflict = db.prepare('SELECT id FROM task_flag_options WHERE value=? AND id!=?').get(clean, optId);
  if (conflict) { res.status(409).json({ error: 'A flag with that value already exists.' }); return; }
  db.prepare('UPDATE task_flag_options SET value=? WHERE id=?').run(clean, optId);
  res.json({ success: true });
});

router.delete('/admin/:id', requireAdmin, validateCsrf, (req: Request, res: Response) => {
  getDb().prepare('DELETE FROM task_flag_options WHERE id=?').run(Number(req.params['id']));
  res.json({ success: true });
});

export default router;
