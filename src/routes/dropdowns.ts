import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { requireAuth, requireAdmin, validateCsrf, requirePasswordChange, requireActivation } from '../middleware/index';

const router = Router();
const ALLOWED = ['category', 'subcategory', 'outcome'];

router.get('/:field', requireAuth, requirePasswordChange, requireActivation, (req: Request, res: Response) => {
  const field = req.params['field'] as string;
  if (!ALLOWED.includes(field)) { res.status(400).json({ error: 'Invalid field.' }); return; }
  const opts = (getDb().prepare(
    `SELECT value FROM dropdown_options WHERE field_name=? AND approved=1 ORDER BY value`
  ).all(field) as any[]).map(r => r.value);
  res.json({ options: opts });
});

router.post('/propose', requireAuth, requirePasswordChange, requireActivation, validateCsrf, (req: Request, res: Response) => {
  const s = req.session as any;
  const { field_name, value } = req.body as { field_name: string; value: string };
  if (!ALLOWED.includes(field_name)) { res.status(400).json({ error: 'Invalid field.' }); return; }
  const clean = (value || '').trim();
  if (!clean || clean.length > 100) { res.status(400).json({ error: 'Invalid value.' }); return; }
  const db = getDb();
  const existing = db.prepare('SELECT id,approved FROM dropdown_options WHERE field_name=? AND value=?').get(field_name, clean) as any;
  if (existing) {
    res.json({ message: existing.approved ? 'Option already exists.' : 'Option already pending review.', value: clean });
    return;
  }
  db.prepare('INSERT OR IGNORE INTO dropdown_options (field_name,value,approved,proposed_by_user_id) VALUES (?,?,0,?)').run(field_name, clean, s.userId);
  res.json({ message: 'Option submitted for admin review.', value: clean });
});

// Admin routes
router.get('/admin/all', requireAdmin, (_req: Request, res: Response) => {
  const opts = getDb().prepare(
    'SELECT id,field_name,value,approved,created_at FROM dropdown_options ORDER BY field_name,approved DESC,value'
  ).all();
  res.json({ options: opts });
});

router.post('/admin', requireAdmin, validateCsrf, (req: Request, res: Response) => {
  const { field_name, value } = req.body as { field_name: string; value: string };
  if (!ALLOWED.includes(field_name) || !(value || '').trim()) { res.status(400).json({ error: 'Invalid.' }); return; }
  getDb().prepare('INSERT OR IGNORE INTO dropdown_options (field_name,value,approved) VALUES (?,?,1)').run(field_name, value.trim());
  res.json({ success: true });
});

router.post('/admin/:id/approve', requireAdmin, validateCsrf, (req: Request, res: Response) => {
  getDb().prepare('UPDATE dropdown_options SET approved=1,proposed_by_user_id=NULL WHERE id=?').run(Number(req.params['id']));
  res.json({ success: true });
});

router.delete('/admin/:id', requireAdmin, validateCsrf, (req: Request, res: Response) => {
  getDb().prepare('DELETE FROM dropdown_options WHERE id=?').run(Number(req.params['id']));
  res.json({ success: true });
});

export default router;
