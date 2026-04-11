/**
 * Build a minimal Express app wired with the same routes as server.ts
 * but using a fresh in-memory (or temp-file) SQLite database so tests
 * are completely isolated from the production data file.
 */
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { getDb, closeDb } from '../../db';
import authRouter from '../../routes/auth';
import tasksRouter from '../../routes/tasks';
import dropdownsRouter from '../../routes/dropdowns';
import adminRouter from '../../routes/admin';
import flagsRouter from '../../routes/flags';
import messagesRouter from '../../routes/messages';
import analyticsRouter from '../../routes/analytics';
import reviewRouter from '../../routes/review';

export function buildTestApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      // secure:false is intentional in the test environment (no HTTPS in CI)
      cookie: { secure: false, sameSite: 'strict' },
    }),
  );
  app.use('/api/auth', authRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/dropdowns', dropdownsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/flags', flagsRouter);
  app.use('/api/messages', messagesRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/suggest/review', reviewRouter);
  return app;
}

/** Seed an admin user and return { username, password, csrfToken, cookie } */
export async function createAdminSession(agent: any) {
  const db = getDb();
  const pw = 'AdminP@ss1!';
  // Cost factor 4 is intentionally low for test speed; production uses 12
  const hash = await bcrypt.hash(pw, 4);
  const username = 'admin_' + crypto.randomBytes(4).toString('hex');
  db.prepare(
    'INSERT INTO users (username,password_hash,is_admin,is_approved,pending_activation) VALUES (?,?,1,1,0)',
  ).run(username, hash);

  const csrfRes = await agent.get('/api/auth/csrf-token');
  const csrf = csrfRes.body.token as string;

  await agent
    .post('/api/auth/login')
    .set('X-CSRF-Token', csrf)
    .send({ username, password: pw });

  const csrf2Res = await agent.get('/api/auth/csrf-token');
  return { username, password: pw, csrf: csrf2Res.body.token as string };
}

/** Seed a normal (non-admin) active user */
export async function createUserSession(agent: any) {
  const db = getDb();
  const pw = 'UserP@ss1!';
  // Cost factor 4 is intentionally low for test speed; production uses 12
  const hash = await bcrypt.hash(pw, 4);
  const username = 'user_' + crypto.randomBytes(4).toString('hex');
  db.prepare(
    'INSERT INTO users (username,password_hash,is_admin,is_approved,pending_activation) VALUES (?,?,0,1,0)',
  ).run(username, hash);

  const csrfRes = await agent.get('/api/auth/csrf-token');
  const csrf = csrfRes.body.token as string;

  await agent
    .post('/api/auth/login')
    .set('X-CSRF-Token', csrf)
    .send({ username, password: pw });

  const csrf2Res = await agent.get('/api/auth/csrf-token');
  return { username, password: pw, csrf: csrf2Res.body.token as string };
}
