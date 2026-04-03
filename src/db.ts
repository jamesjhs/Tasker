import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, 'tasker.db');
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
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      is_admin INTEGER NOT NULL DEFAULT 0,
      mfa_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_duty INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

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
}
