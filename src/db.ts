import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Allow tests to override the DB path via environment variable (e.g. ':memory:' or a temp file)
export const DB_PATH = process.env['TASKER_DB_PATH'] || path.join(DATA_DIR, 'tasker.db');
const RESTORE_DIR = path.join(DATA_DIR, 'restore-tmp');
if (!fs.existsSync(RESTORE_DIR)) fs.mkdirSync(RESTORE_DIR, { recursive: true });
export { RESTORE_DIR };

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    initSchema(_db);
  }
  return _db;
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run(key, value);
}

export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}

export function replaceDb(uploadedPath: string): void {
  const resolved = path.resolve(uploadedPath);
  const allowedDir = path.resolve(RESTORE_DIR);
  if (!resolved.startsWith(allowedDir + path.sep)) {
    throw new Error('Invalid restore path');
  }
  closeDb();
  fs.copyFileSync(resolved, DB_PATH);
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_approved INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_approved INTEGER NOT NULL DEFAULT 1,
      pending_activation INTEGER NOT NULL DEFAULT 0,
      mfa_enabled INTEGER NOT NULL DEFAULT 0,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      is_locked INTEGER NOT NULL DEFAULT 0,
      user_group_id INTEGER REFERENCES user_groups(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_duty INTEGER NOT NULL DEFAULT 0,
      assigned_date TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT,
      category TEXT,
      subcategory TEXT,
      outcome TEXT,
      interruptions TEXT NOT NULL DEFAULT '[]',
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dropdown_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_name TEXT NOT NULL,
      value TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      proposed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(field_name, value)
    );

    CREATE TABLE IF NOT EXISTS group_dropdown_options (
      group_id INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
      dropdown_option_id INTEGER NOT NULL REFERENCES dropdown_options(id) ON DELETE CASCADE,
      PRIMARY KEY (group_id, dropdown_option_id)
    );

    CREATE TABLE IF NOT EXISTS user_dropdown_options (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      dropdown_option_id INTEGER NOT NULL REFERENCES dropdown_options(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, dropdown_option_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pending_task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      count INTEGER NOT NULL,
      logged_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_flag_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      value TEXT NOT NULL UNIQUE,
      approved INTEGER NOT NULL DEFAULT 1,
      proposed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_flags (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      flag_option_id INTEGER NOT NULL REFERENCES task_flag_options(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, flag_option_id)
    );

    CREATE TABLE IF NOT EXISTS dropdown_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      review_token TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS flag_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_dropdown_proposals_field ON dropdown_proposals(field_name);

    CREATE INDEX IF NOT EXISTS idx_users_broadcast ON users(is_admin, is_approved, pending_activation);
  `);

  // Migrate existing databases: add lockout columns if missing
  const userCols = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map(c => c.name);
  if (!userCols.includes('failed_login_attempts')) {
    db.exec('ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0');
  }
  if (!userCols.includes('is_locked')) {
    db.exec('ALTER TABLE users ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0');
  }
  if (!userCols.includes('is_approved')) {
    db.exec('ALTER TABLE users ADD COLUMN is_approved INTEGER NOT NULL DEFAULT 1');
  }
  if (!userCols.includes('pending_activation')) {
    db.exec('ALTER TABLE users ADD COLUMN pending_activation INTEGER NOT NULL DEFAULT 0');
  }
  if (!userCols.includes('user_group_id')) {
    db.exec('ALTER TABLE users ADD COLUMN user_group_id INTEGER');
  }

  // Migrate existing databases: add is_approved to user_groups (for pending group proposals)
  const groupCols = (db.prepare("PRAGMA table_info(user_groups)").all() as { name: string }[]).map(c => c.name);
  if (!groupCols.includes('is_approved')) {
    db.exec('ALTER TABLE user_groups ADD COLUMN is_approved INTEGER NOT NULL DEFAULT 1');
  }

  // Migrate existing databases: add assigned_date column if missing
  const taskCols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(c => c.name);
  if (!taskCols.includes('assigned_date')) {
    db.exec('ALTER TABLE tasks ADD COLUMN assigned_date TEXT');
  }

  // Migrate existing databases: add review_token to dropdown_proposals if missing
  const proposalCols = (db.prepare("PRAGMA table_info(dropdown_proposals)").all() as { name: string }[]).map(c => c.name);
  if (!proposalCols.includes('review_token')) {
    db.exec('ALTER TABLE dropdown_proposals ADD COLUMN review_token TEXT');
  }

  // Seed default registration settings if not present
  const insOrIgnoreSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)');
  insOrIgnoreSetting.run('self_registration', 'admin_approved');
  insOrIgnoreSetting.run('user_invite', 'admin_approved');

  // Seed default dropdowns if empty
  const count = (db.prepare('SELECT COUNT(*) as c FROM dropdown_options WHERE approved=1').get() as { c: number }).c;
  if (count === 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO dropdown_options (field_name,value,approved) VALUES (?,?,1)');
    const seed = db.transaction((rows: [string, string][]) => { for (const [f, v] of rows) ins.run(f, v); });
    seed([
      ['category', 'Clinical'], ['category', 'Administrative'], ['category', 'Teaching'],
      ['category', 'Research'], ['category', 'Management'],
      ['subcategory', 'Direct patient care'], ['subcategory', 'Documentation'],
      ['subcategory', 'Communication'], ['subcategory', 'Handover'], ['subcategory', 'Referral'],
      ['outcome', 'Completed'], ['outcome', 'Delegated'], ['outcome', 'Escalated'],
      ['outcome', 'Deferred'], ['outcome', 'Abandoned'],
    ]);
  }

  // Seed default user group if none exist
  const groupCount = (db.prepare('SELECT COUNT(*) as c FROM user_groups').get() as { c: number }).c;
  if (groupCount === 0) {
    const result = db.prepare('INSERT INTO user_groups (name) VALUES (?)').run('General');
    const generalGroupId = result.lastInsertRowid as number;
    // Assign all existing approved dropdown options to the default group
    db.prepare(
      'INSERT OR IGNORE INTO group_dropdown_options (group_id, dropdown_option_id) SELECT ?,id FROM dropdown_options WHERE approved=1'
    ).run(generalGroupId);
  }


  const flagCount = (db.prepare('SELECT COUNT(*) as c FROM task_flag_options WHERE approved=1').get() as { c: number }).c;
  if (flagCount === 0) {
    const insFlag = db.prepare('INSERT OR IGNORE INTO task_flag_options (value, approved) VALUES (?,1)');
    const seedFlags = db.transaction((vals: string[]) => { for (const v of vals) insFlag.run(v); });
    seedFlags([
      'Sent to wrong user',
      'Priority too high',
      'Priority too low',
      'Should be sent to group',
      'Should be sent to specific user',
    ]);
  }
}
