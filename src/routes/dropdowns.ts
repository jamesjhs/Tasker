import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { requireAuth, requireAdmin, validateCsrf, requirePasswordChange, requireActivation } from '../middleware/index';
import { sendEmail } from '../email';

const router = Router();
const ALLOWED = ['category', 'subcategory', 'outcome'];

router.get('/:field', requireAuth, requirePasswordChange, requireActivation, (req: Request, res: Response) => {
  const field = req.params['field'] as string;
  if (!ALLOWED.includes(field)) { res.status(400).json({ error: 'Invalid field.' }); return; }
  const s = req.session as any;
  const db = getDb();
  if (s.userId) {
    // 1. Check if user has any personal options at all
    const personalTotal = (db.prepare('SELECT COUNT(*) as c FROM user_dropdown_options WHERE user_id=?').get(s.userId) as { c: number }).c;
    if (personalTotal > 0) {
      // Use personal options for this field (may be empty if user deselected all)
      const rows = db.prepare(
        `SELECT do.value FROM dropdown_options do
         INNER JOIN user_dropdown_options udo ON udo.dropdown_option_id=do.id
         WHERE do.field_name=? AND do.approved=1 AND udo.user_id=?
         ORDER BY do.value`
      ).all(field, s.userId) as { value: string }[];
      res.json({ options: rows.map(r => r.value) });
      return;
    }
    // 2. Fall back to group options
    const user = db.prepare('SELECT user_group_id FROM users WHERE id=?').get(s.userId) as { user_group_id: number | null } | undefined;
    const groupId = user?.user_group_id ?? null;
    if (groupId !== null) {
      const rows = db.prepare(
        `SELECT do.value FROM dropdown_options do
         INNER JOIN group_dropdown_options gdo ON gdo.dropdown_option_id=do.id
         WHERE do.field_name=? AND do.approved=1 AND gdo.group_id=?
         ORDER BY do.value`
      ).all(field, groupId) as { value: string }[];
      if (rows.length > 0) {
        res.json({ options: rows.map(r => r.value) });
        return;
      }
    }
  }
  // 3. Fall back: return all approved options
  const opts = (db.prepare(
    'SELECT value FROM dropdown_options WHERE field_name=? AND approved=1 ORDER BY value'
  ).all(field) as { value: string }[]).map(r => r.value);
  res.json({ options: opts });
});

router.post('/propose', requireAuth, requirePasswordChange, requireActivation, validateCsrf, async (req: Request, res: Response) => {
  const s = req.session as any;
  const { field_name, value } = req.body as { field_name: string; value: string };
  if (!ALLOWED.includes(field_name)) { res.status(400).json({ error: 'Invalid field.' }); return; }
  const clean = (value || '').trim();
  if (!clean || clean.length > 100) { res.status(400).json({ error: 'Invalid value.' }); return; }

  // Check if already an approved option (no need to email)
  const existing = getDb().prepare('SELECT id, approved FROM dropdown_options WHERE field_name=? AND value=?').get(field_name, clean) as any;
  if (existing?.approved) { res.json({ message: 'Option already exists.', value: clean }); return; }

  const fieldLabels: Record<string, string> = { category: 'Task From', subcategory: 'Task Type', outcome: 'Outcome' };
  const username = (getDb().prepare('SELECT username FROM users WHERE id=?').get(s.userId) as any)?.username || 'Unknown';

  // Store a metadata-only proposal record (no free-text value stored in DB)
  const proposalResult = getDb().prepare('INSERT INTO dropdown_proposals (user_id, field_name) VALUES (?,?)').run(s.userId, field_name);
  const proposalId = proposalResult.lastInsertRowid;

  try {
    await sendEmail(
      `Tasker: New dropdown suggestion — ${fieldLabels[field_name] || field_name}`,
      `User "${username}" has suggested a new option for "${fieldLabels[field_name] || field_name}":\n\n"${clean}"\n\nPlease log in to the Tasker admin panel, add this option manually, and approve it so the user sees it in their dropdown.`,
    );
    res.json({ message: 'Your suggestion has been sent to the administrator by email.', value: clean });
  } catch (e: any) {
    // Remove the proposal record if email failed
    getDb().prepare('DELETE FROM dropdown_proposals WHERE id=?').run(proposalId);
    res.status(503).json({ error: `Could not send suggestion: ${e?.message || 'SMTP error'}` });
  }
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
  const fieldLabels: Record<string, string> = { category: 'Task From', subcategory: 'Task Type', outcome: 'Outcome' };
  try {
    const result = db.prepare('INSERT OR IGNORE INTO dropdown_options (field_name,value,approved) VALUES (?,?,1)').run(field_name, value.trim());
    if (result.changes > 0) {
      const newId = result.lastInsertRowid as number;
      // Assign new option to all existing user groups automatically
      db.prepare(
        'INSERT OR IGNORE INTO group_dropdown_options (group_id, dropdown_option_id) SELECT id,? FROM user_groups'
      ).run(newId);
    }
    // Notify users who had pending proposals for this field
    const proposals = db.prepare(
      'SELECT DISTINCT user_id FROM dropdown_proposals WHERE field_name=?'
    ).all(field_name) as { user_id: number }[];
    if (proposals.length > 0) {
      const insMsg = db.prepare('INSERT INTO user_messages (user_id, message) VALUES (?,?)');
      const msg = `Your suggested option for "${fieldLabels[field_name] || field_name}" has been reviewed and a new option has been added to the list. Please check the dropdown to see if it matches your suggestion.`;
      db.transaction(() => {
        for (const p of proposals) insMsg.run(p.user_id, msg);
        db.prepare('DELETE FROM dropdown_proposals WHERE field_name=?').run(field_name);
      })();
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
