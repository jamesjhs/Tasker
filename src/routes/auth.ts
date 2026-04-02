import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db';

const router = Router();

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { username, email, password } = req.body as {
    username?: string;
    email?: string;
    password?: string;
  };

  if (!username || !email || !password) {
    res.status(400).json({ error: 'Username, email and password are required.' });
    return;
  }

  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters.' });
    return;
  }

  const db = getDb();
  const existing = db.prepare(
    'SELECT id FROM users WHERE username = ? OR email = ?'
  ).get(username, email);

  if (existing) {
    res.status(409).json({ error: 'Username or email already registered.' });
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  const result = db.prepare(
    'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)'
  ).run(username.trim(), email.trim().toLowerCase(), hash);

  req.session.userId = result.lastInsertRowid as number;
  req.session.username = username.trim();
  res.status(201).json({ message: 'Account created.', username: username.trim() });
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body as {
    username?: string;
    password?: string;
  };

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required.' });
    return;
  }

  const db = getDb();
  const user = db.prepare(
    'SELECT id, username, password_hash FROM users WHERE username = ?'
  ).get(username) as { id: number; username: string; password_hash: string } | undefined;

  if (!user) {
    res.status(401).json({ error: 'Invalid username or password.' });
    return;
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    res.status(401).json({ error: 'Invalid username or password.' });
    return;
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ message: 'Logged in.', username: user.username });
});

// POST /api/auth/logout
router.post('/logout', (req: Request, res: Response): void => {
  req.session.destroy(() => {
    res.json({ message: 'Logged out.' });
  });
});

// GET /api/auth/me
router.get('/me', (req: Request, res: Response): void => {
  if (req.session?.userId) {
    res.json({ userId: req.session.userId, username: req.session.username });
  } else {
    res.status(401).json({ error: 'Not authenticated.' });
  }
});

export default router;
