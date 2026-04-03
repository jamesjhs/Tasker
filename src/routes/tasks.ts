import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { requireAuth, validateCsrf, requirePasswordChange, requireActivation, logEvent } from '../middleware/index';

const router = Router();
router.use(requireAuth);
router.use(requirePasswordChange);
router.use(requireActivation);

router.get('/active', (req: Request, res: Response) => {
  const s = req.session as any;
  const task = getDb().prepare(
    `SELECT * FROM tasks WHERE user_id=? AND status='in_progress' ORDER BY created_at DESC LIMIT 1`
  ).get(s.userId) as any;
  if (!task) { res.json({ task: null }); return; }
  task.interruptions = JSON.parse(task.interruptions || '[]');
  res.json({ task });
});

router.post('/start', validateCsrf, (req: Request, res: Response) => {
  const s = req.session as any;
  const db = getDb();
  const active = db.prepare(`SELECT id FROM tasks WHERE user_id=? AND status='in_progress'`).get(s.userId);
  if (active) { res.status(409).json({ error: 'You already have an active task. Complete or discard it first.' }); return; }
  const { is_duty, category, subcategory, outcome, notes, start_time, assigned_date } = req.body as any;
  const now = start_time || new Date().toISOString();
  if (new Date(now).toDateString() !== new Date().toDateString()) {
    res.status(400).json({ error: 'Task start time must be today.' }); return;
  }
  const r = db.prepare(
    `INSERT INTO tasks (user_id,is_duty,assigned_date,start_time,category,subcategory,outcome,notes,status)
     VALUES (?,?,?,?,?,?,?,?,'in_progress')`
  ).run(s.userId, is_duty ? 1 : 0, assigned_date || null, now, category || null, subcategory || null, outcome || null, notes || null);
  logEvent('task_started');
  res.json({ taskId: r.lastInsertRowid });
});

router.patch('/:id', validateCsrf, (req: Request, res: Response) => {
  const s = req.session as any;
  const db = getDb();
  const taskId = Number(req.params['id']);
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(taskId, s.userId) as any;
  if (!task) { res.status(404).json({ error: 'Task not found.' }); return; }
  const { status, end_time, category, subcategory, outcome, notes, interruptions, is_duty } = req.body as any;
  if (end_time && new Date(end_time).toDateString() !== new Date().toDateString()) {
    res.status(400).json({ error: 'Task end time must be today.' }); return;
  }
  const cols: string[] = [];
  const vals: any[] = [];
  if (status !== undefined)       { cols.push('status=?');        vals.push(status); }
  if (end_time !== undefined)     { cols.push('end_time=?');      vals.push(end_time); }
  if (category !== undefined)     { cols.push('category=?');      vals.push(category); }
  if (subcategory !== undefined)  { cols.push('subcategory=?');   vals.push(subcategory); }
  if (outcome !== undefined)      { cols.push('outcome=?');       vals.push(outcome); }
  if (notes !== undefined)        { cols.push('notes=?');         vals.push(notes); }
  if (is_duty !== undefined)      { cols.push('is_duty=?');       vals.push(is_duty ? 1 : 0); }
  if (interruptions !== undefined){ cols.push('interruptions=?'); vals.push(JSON.stringify(interruptions)); }
  cols.push(`updated_at=datetime('now')`);
  vals.push(taskId, s.userId);
  db.prepare(`UPDATE tasks SET ${cols.join(',')} WHERE id=? AND user_id=?`).run(...vals);
  if (status === 'completed') logEvent('task_completed');
  if (status === 'discarded') logEvent('task_discarded');
  res.json({ success: true });
});

router.get('/', (req: Request, res: Response) => {
  const s = req.session as any;
  const { from, to, is_duty, category, outcome, status: qs } = req.query as Record<string, string>;
  let q = `SELECT * FROM tasks WHERE user_id=? AND status!='discarded'`;
  const p: any[] = [s.userId];
  if (from)                  { q += ' AND start_time>=?'; p.push(from); }
  if (to)                    { q += ' AND start_time<=?'; p.push(to + 'T23:59:59'); }
  if (is_duty !== undefined) { q += ' AND is_duty=?'; p.push(is_duty === 'true' ? 1 : 0); }
  if (category)              { q += ' AND category=?'; p.push(category); }
  if (outcome)               { q += ' AND outcome=?'; p.push(outcome); }
  if (qs)                    { q += ' AND status=?'; p.push(qs); }
  q += ' ORDER BY start_time DESC';
  const tasks = (getDb().prepare(q).all(...p) as any[]).map(t => ({
    ...t, interruptions: JSON.parse(t.interruptions || '[]'),
  }));
  res.json({ tasks });
});

router.get('/:id', (req: Request, res: Response) => {
  const s = req.session as any;
  const task = getDb().prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(Number(req.params['id']), s.userId) as any;
  if (!task) { res.status(404).json({ error: 'Task not found.' }); return; }
  task.interruptions = JSON.parse(task.interruptions || '[]');
  res.json({ task });
});

router.delete('/', validateCsrf, (req: Request, res: Response) => {
  const s = req.session as any;
  const r = getDb().prepare(`DELETE FROM tasks WHERE user_id=? AND status!='in_progress'`).run(s.userId);
  logEvent('tasks_cleared');
  res.json({ deleted: r.changes, message: `${r.changes} task(s) deleted. Active tasks were not affected.` });
});

router.delete('/:id', validateCsrf, (req: Request, res: Response) => {
  const s = req.session as any;
  const db = getDb();
  const taskId = Number(req.params['id']);
  const task = db.prepare('SELECT id FROM tasks WHERE id=? AND user_id=?').get(taskId, s.userId) as any;
  if (!task) { res.status(404).json({ error: 'Task not found.' }); return; }
  db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').run(taskId, s.userId);
  logEvent('task_deleted');
  res.json({ success: true });
});

export default router;
