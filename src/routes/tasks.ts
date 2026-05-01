import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { requireAuth, validateCsrf, requirePasswordChange, requireActivation, logEvent } from '../middleware/index';

const router = Router();
router.use(requireAuth);
router.use(requirePasswordChange);
router.use(requireActivation);

router.get('/recent-count', (req: Request, res: Response) => {
  const s = req.session as any;
  const row = getDb().prepare(
    `SELECT COUNT(*) AS count FROM tasks WHERE user_id=? AND status='completed' AND end_time >= datetime('now','-7 days')`
  ).get(s.userId) as any;
  res.json({ count: row?.count ?? 0 });
});

router.get('/pending-count', (req: Request, res: Response) => {
  const s = req.session as any;
  const log = getDb().prepare(
    `SELECT count, logged_at FROM pending_task_logs WHERE user_id=? ORDER BY logged_at DESC LIMIT 1`
  ).get(s.userId) as any;
  res.json(log || null);
});

router.get('/pending-count/history', (req: Request, res: Response) => {
  const s = req.session as any;
  const daysParam = Number(req.query['days']);
  const days = daysParam === 30 ? 30 : 7;
  const modifier = `-${days} days`;
  const logs = getDb().prepare(
    `SELECT count, logged_at FROM pending_task_logs WHERE user_id=? AND logged_at >= datetime('now',?) ORDER BY logged_at ASC`
  ).all(s.userId, modifier) as any[];
  res.json(logs);
});

router.post('/pending-count', validateCsrf, (req: Request, res: Response) => {
  const s = req.session as any;
  const count = Number(req.body?.count);
  if (!Number.isInteger(count) || count < 0 || count > 9999) {
    res.status(400).json({ error: 'Count must be an integer between 0 and 9999.' }); return;
  }
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO pending_task_logs (user_id, count, logged_at) VALUES (?,?,?)`
  ).run(s.userId, count, now);
  logEvent('pending_count_logged');
  res.json({ count, logged_at: now });
});

router.get('/active', (req: Request, res: Response) => {
  const s = req.session as any;
  const task = getDb().prepare(
    `SELECT * FROM tasks WHERE user_id=? AND status='in_progress' ORDER BY created_at DESC LIMIT 1`
  ).get(s.userId) as any;
  if (!task) { res.json({ task: null }); return; }
  task.interruptions = JSON.parse(task.interruptions || '[]');
  task.flag_ids = (getDb().prepare('SELECT flag_option_id FROM task_flags WHERE task_id=?').all(task.id) as any[]).map(r => r.flag_option_id);
  res.json({ task });
});

router.post('/start', validateCsrf, (req: Request, res: Response) => {
  const s = req.session as any;
  const db = getDb();
  const active = db.prepare(`SELECT id FROM tasks WHERE user_id=? AND status='in_progress'`).get(s.userId);
  if (active) { res.status(409).json({ error: 'You already have an active task. Complete or discard it first.' }); return; }
  const { is_duty, category, subcategory, outcome, start_time, assigned_date } = req.body as any;
  const now = start_time || new Date().toISOString();
  if (new Date(now).toDateString() !== new Date().toDateString()) {
    res.status(400).json({ error: 'Task start time must be today.' }); return;
  }
  const r = db.prepare(
    `INSERT INTO tasks (user_id,is_duty,assigned_date,start_time,category,subcategory,outcome,status)
     VALUES (?,?,?,?,?,?,?,'in_progress')`
  ).run(s.userId, is_duty ? 1 : 0, assigned_date || null, now, category || null, subcategory || null, outcome || null);
  logEvent('task_started');
  res.json({ taskId: r.lastInsertRowid });
});

router.patch('/:id', validateCsrf, (req: Request, res: Response) => {
  const s = req.session as any;
  const db = getDb();
  const taskId = Number(req.params['id']);
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(taskId, s.userId) as any;
  if (!task) { res.status(404).json({ error: 'Task not found.' }); return; }
  const { status, end_time, start_time, category, subcategory, outcome, flag_ids, interruptions, is_duty, assigned_date } = req.body as any;
  // Only enforce today's date for end_time when the task is still in-progress (i.e. being completed now)
  if (end_time && task.status === 'in_progress' && new Date(end_time).toDateString() !== new Date().toDateString()) {
    res.status(400).json({ error: 'Task end time must be today.' }); return;
  }
  // Only enforce today's date for start_time on in-progress tasks (historical edits are allowed)
  if (start_time !== undefined && task.status === 'in_progress') {
    if (new Date(start_time).toDateString() !== new Date().toDateString()) {
      res.status(400).json({ error: 'Task start time must be today.' }); return;
    }
  }
  // Validate temporal consistency when both times are present
  const effectiveStart = start_time !== undefined ? start_time : task.start_time;
  const effectiveEnd = end_time !== undefined ? end_time : task.end_time;
  if (effectiveStart && effectiveEnd && new Date(effectiveStart) > new Date(effectiveEnd)) {
    res.status(400).json({ error: 'Start time must be before end time.' }); return;
  }
  const cols: string[] = [];
  const vals: any[] = [];
  if (status !== undefined)       { cols.push('status=?');        vals.push(status); }
  if (end_time !== undefined)     { cols.push('end_time=?');      vals.push(end_time); }
  if (start_time !== undefined)   { cols.push('start_time=?');    vals.push(start_time); }
  if (category !== undefined)     { cols.push('category=?');      vals.push(category); }
  if (subcategory !== undefined)  { cols.push('subcategory=?');   vals.push(subcategory); }
  if (outcome !== undefined)      { cols.push('outcome=?');       vals.push(outcome); }
  if (is_duty !== undefined)      { cols.push('is_duty=?');       vals.push(is_duty ? 1 : 0); }
  if (assigned_date !== undefined){ cols.push('assigned_date=?'); vals.push(assigned_date || null); }
  if (interruptions !== undefined){ cols.push('interruptions=?'); vals.push(JSON.stringify(interruptions)); }
  cols.push(`updated_at=datetime('now')`);
  vals.push(taskId, s.userId);
  db.transaction(() => {
    db.prepare(`UPDATE tasks SET ${cols.join(',')} WHERE id=? AND user_id=?`).run(...vals);
    if (flag_ids !== undefined && Array.isArray(flag_ids)) {
      const candidateIds = flag_ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
      db.prepare('DELETE FROM task_flags WHERE task_id=?').run(taskId);
      if (candidateIds.length > 0) {
        // Batch-validate flag option IDs (avoids N+1 and FK constraint errors)
        const placeholders = candidateIds.map(() => '?').join(',');
        const validIds = new Set(
          (db.prepare(`SELECT id FROM task_flag_options WHERE id IN (${placeholders})`).all(...candidateIds) as any[])
            .map(r => r.id)
        );
        const insFlag = db.prepare('INSERT OR IGNORE INTO task_flags (task_id, flag_option_id) VALUES (?,?)');
        for (const n of candidateIds) {
          if (validIds.has(n)) insFlag.run(taskId, n);
        }
      }
    }
  })();
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
  const db = getDb();
  const raw = db.prepare(q).all(...p) as any[];

  // Batch-fetch all flag_ids for the returned tasks (avoids N+1)
  const flagIdsMap = new Map<number, number[]>();
  if (raw.length > 0) {
    const placeholders = raw.map(() => '?').join(',');
    (db.prepare(`SELECT task_id, flag_option_id FROM task_flags WHERE task_id IN (${placeholders})`).all(...raw.map(t => t.id)) as any[])
      .forEach(r => {
        if (!flagIdsMap.has(r.task_id)) flagIdsMap.set(r.task_id, []);
        flagIdsMap.get(r.task_id)!.push(r.flag_option_id);
      });
  }

  const tasks = raw.map(t => ({
    ...t,
    interruptions: JSON.parse(t.interruptions || '[]'),
    flag_ids: flagIdsMap.get(t.id) || [],
  }));
  res.json({ tasks });
});

router.get('/common-fields', (req: Request, res: Response) => {
  const s = req.session as any;
  const db = getDb();
  const ALLOWED_FIELDS = new Set(['category', 'subcategory', 'outcome']);
  const topN = (field: string, limit: number): string[] => {
    if (!ALLOWED_FIELDS.has(field)) return [];
    return (db.prepare(
      `SELECT ${field}, COUNT(*) as cnt FROM tasks WHERE user_id=? AND ${field} IS NOT NULL AND status='completed' AND start_time >= datetime('now', '-30 days') GROUP BY ${field} ORDER BY cnt DESC LIMIT ?`
    ).all(s.userId, limit) as any[]).map(r => r[field]);
  };
  res.json({
    category:    topN('category', 6),
    subcategory: topN('subcategory', 6),
    outcome:     topN('outcome', 9),
  });
});

router.get('/:id', (req: Request, res: Response) => {
  const s = req.session as any;
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(Number(req.params['id']), s.userId) as any;
  if (!task) { res.status(404).json({ error: 'Task not found.' }); return; }
  task.interruptions = JSON.parse(task.interruptions || '[]');
  task.flag_ids = (db.prepare('SELECT flag_option_id FROM task_flags WHERE task_id=?').all(task.id) as any[]).map(r => r.flag_option_id);
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
