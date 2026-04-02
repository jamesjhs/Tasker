import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

interface Task {
  id: number;
  user_id: number;
  task_type: string;
  team: string;
  sender_initials: string;
  start_time: string;
  finish_time: string | null;
  outcome: string | null;
  appropriate: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// GET /api/tasks  — list tasks for the logged-in user
router.get('/', (req: Request, res: Response): void => {
  const db = getDb();
  const tasks = db.prepare(
    'SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.session.userId) as Task[];
  res.json(tasks);
});

// POST /api/tasks  — create a new task
router.post('/', (req: Request, res: Response): void => {
  const {
    task_type,
    team,
    sender_initials,
    start_time,
    finish_time,
    outcome,
    appropriate,
    notes,
  } = req.body as Partial<{
    task_type: string;
    team: string;
    sender_initials: string;
    start_time: string;
    finish_time: string;
    outcome: string;
    appropriate: boolean;
    notes: string;
  }>;

  if (!task_type || !team || !sender_initials || !start_time) {
    res.status(400).json({ error: 'task_type, team, sender_initials and start_time are required.' });
    return;
  }

  const userId = req.session.userId as number;
  const db = getDb();

  const result = db.prepare(`
    INSERT INTO tasks (user_id, task_type, team, sender_initials, start_time, finish_time, outcome, appropriate, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    task_type.trim(),
    team.trim(),
    sender_initials.trim().toUpperCase(),
    start_time,
    finish_time || null,
    outcome || null,
    appropriate === false ? 0 : 1,
    notes?.trim() || null,
  );

  // Keep task_types catalogue up to date
  db.prepare(
    'INSERT OR IGNORE INTO task_types (user_id, name) VALUES (?, ?)'
  ).run(userId, task_type.trim());

  // Keep teams catalogue up to date
  db.prepare(
    'INSERT OR IGNORE INTO teams (user_id, name) VALUES (?, ?)'
  ).run(userId, team.trim());

  const created = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid) as Task;
  res.status(201).json(created);
});

// PATCH /api/tasks/:id  — update a task (e.g. set finish_time or outcome)
router.patch('/:id', (req: Request, res: Response): void => {
  const taskId = parseInt(req.params['id'] as string, 10);
  if (isNaN(taskId)) {
    res.status(400).json({ error: 'Invalid task id.' });
    return;
  }

  const userId = req.session.userId as number;
  const db = getDb();

  const task = db.prepare(
    'SELECT * FROM tasks WHERE id = ? AND user_id = ?'
  ).get(taskId, userId) as Task | undefined;

  if (!task) {
    res.status(404).json({ error: 'Task not found.' });
    return;
  }

  const {
    task_type,
    team,
    sender_initials,
    start_time,
    finish_time,
    outcome,
    appropriate,
    notes,
  } = req.body as Partial<{
    task_type: string;
    team: string;
    sender_initials: string;
    start_time: string;
    finish_time: string;
    outcome: string;
    appropriate: boolean;
    notes: string;
  }>;

  const updated = {
    task_type: task_type !== undefined ? task_type.trim() : task.task_type,
    team: team !== undefined ? team.trim() : task.team,
    sender_initials: sender_initials !== undefined ? sender_initials.trim().toUpperCase() : task.sender_initials,
    start_time: start_time !== undefined ? start_time : task.start_time,
    finish_time: finish_time !== undefined ? finish_time || null : task.finish_time,
    outcome: outcome !== undefined ? outcome || null : task.outcome,
    appropriate: appropriate !== undefined ? (appropriate === false ? 0 : 1) : task.appropriate,
    notes: notes !== undefined ? notes?.trim() || null : task.notes,
  };

  db.prepare(`
    UPDATE tasks
    SET task_type = ?, team = ?, sender_initials = ?, start_time = ?,
        finish_time = ?, outcome = ?, appropriate = ?, notes = ?,
        updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(
    updated.task_type,
    updated.team,
    updated.sender_initials,
    updated.start_time,
    updated.finish_time,
    updated.outcome,
    updated.appropriate,
    updated.notes,
    taskId,
    userId,
  );

  // Keep catalogues up to date
  if (task_type) {
    db.prepare('INSERT OR IGNORE INTO task_types (user_id, name) VALUES (?, ?)').run(userId, updated.task_type);
  }
  if (team) {
    db.prepare('INSERT OR IGNORE INTO teams (user_id, name) VALUES (?, ?)').run(userId, updated.team);
  }

  const result = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task;
  res.json(result);
});

// DELETE /api/tasks/:id
router.delete('/:id', (req: Request, res: Response): void => {
  const taskId = parseInt(req.params['id'] as string, 10);
  if (isNaN(taskId)) {
    res.status(400).json({ error: 'Invalid task id.' });
    return;
  }

  const userId = req.session.userId as number;
  const db = getDb();

  const info = db.prepare(
    'DELETE FROM tasks WHERE id = ? AND user_id = ?'
  ).run(taskId, userId);

  if (info.changes === 0) {
    res.status(404).json({ error: 'Task not found.' });
    return;
  }

  res.json({ message: 'Task deleted.' });
});

// GET /api/tasks/meta/types  — distinct task types for the user
router.get('/meta/types', (req: Request, res: Response): void => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT name FROM task_types WHERE user_id = ? ORDER BY name ASC'
  ).all(req.session.userId) as { name: string }[];
  res.json(rows.map(r => r.name));
});

// GET /api/tasks/meta/teams  — distinct teams for the user
router.get('/meta/teams', (req: Request, res: Response): void => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT name FROM teams WHERE user_id = ? ORDER BY name ASC'
  ).all(req.session.userId) as { name: string }[];
  res.json(rows.map(r => r.name));
});

export default router;
