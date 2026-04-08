import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { requireAuth, requireAdmin, validateCsrf, requirePasswordChange, requireActivation } from '../middleware/index';

const router = Router();
const ALLOWED = ['category', 'subcategory', 'outcome'];

router.get('/:field', requireAuth, requirePasswordChange, requireActivation, (req: Request, res: Response) => {
  const field = req.params['field'] as string;
  if (!ALLOWED.includes(field)) { res.status(400).json({ error: 'Invalid field.' }); return; }
  const s = req.session as any;
  const db = getDb();
  let opts: string[];
  if (s.userId) {
    const user = db.prepare('SELECT user_group_id FROM users WHERE id=?').get(s.userId) as { user_group_id: number | null } | undefined;
    const groupId = user?.user_group_id ?? null;
    if (groupId !== null) {
      // Return only options assigned to this group
      const rows = db.prepare(
        `SELECT do.value FROM dropdown_options do
         INNER JOIN group_dropdown_options gdo ON gdo.dropdown_option_id=do.id
         WHERE do.field_name=? AND do.approved=1 AND gdo.group_id=?
         ORDER BY do.value`
      ).all(field, groupId) as any[];
      if (rows.length > 0) {
        opts = rows.map(r => r.value);
        res.json({ options: opts });
        return;
      }
    }
  }
  // Fall back: return all approved options
  opts = (db.prepare(
    'SELECT value FROM dropdown_options WHERE field_name=? AND approved=1 ORDER BY value'
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
  const db = getDb();
  try {
    const result = db.prepare('INSERT OR IGNORE INTO dropdown_options (field_name,value,approved) VALUES (?,?,1)').run(field_name, value.trim());
    if (result.changes > 0) {
      const newId = result.lastInsertRowid as number;
      // Assign new option to all existing user groups automatically
      db.prepare(
        'INSERT OR IGNORE INTO group_dropdown_options (group_id, dropdown_option_id) SELECT id,? FROM user_groups'
      ).run(newId);
    }
    res.json({ success: true });
  } catch {
    res.status(409).json({ error: 'Option already exists.' });
  }
});

router.put('/admin/:id', requireAdmin, validateCsrf, (req: Request, res: Response) => {
  const optId = Number(req.params['id']);
  const { value } = req.body as { value: string };
  const clean = (value || '').trim();
  if (!clean || clean.length > 100) { res.status(400).json({ error: 'Invalid value.' }); return; }
  const db = getDb();
  const opt = db.prepare('SELECT id, field_name FROM dropdown_options WHERE id=?').get(optId) as { id: number; field_name: string } | undefined;
  if (!opt) { res.status(404).json({ error: 'Option not found.' }); return; }
  // Check uniqueness within same field
  const conflict = db.prepare('SELECT id FROM dropdown_options WHERE field_name=? AND value=? AND id!=?').get(opt.field_name, clean, optId);
  if (conflict) { res.status(409).json({ error: 'An option with that value already exists.' }); return; }
  db.prepare('UPDATE dropdown_options SET value=? WHERE id=?').run(clean, optId);
  res.json({ success: true });
});

router.post('/admin/:id/approve', requireAdmin, validateCsrf, (req: Request, res: Response) => {
  const db = getDb();
  const optId = Number(req.params['id']);
  db.prepare('UPDATE dropdown_options SET approved=1,proposed_by_user_id=NULL WHERE id=?').run(optId);
  // Assign newly approved option to all user groups
  db.prepare(
    'INSERT OR IGNORE INTO group_dropdown_options (group_id, dropdown_option_id) SELECT id,? FROM user_groups'
  ).run(optId);
  res.json({ success: true });
});

router.delete('/admin/:id', requireAdmin, validateCsrf, (req: Request, res: Response) => {
  getDb().prepare('DELETE FROM dropdown_options WHERE id=?').run(Number(req.params['id']));
  res.json({ success: true });
});

export default router;
