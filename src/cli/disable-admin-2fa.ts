/**
 * CLI utility: disable 2FA and unlock the admin account.
 *
 * Usage (after building):
 *   npm run disable-admin-2fa
 *
 * Usage (without building):
 *   npx ts-node src/cli/disable-admin-2fa.ts
 *
 * The database path is resolved the same way as the main application.
 * Override it with the TASKER_DB_PATH environment variable if needed.
 *
 * The application does NOT need to be stopped before running this script,
 * but stopping it first is recommended to avoid concurrent write conflicts.
 */

import { getDb, closeDb, DB_PATH } from '../db';

function main(): void {
  console.log(`Database: ${DB_PATH}`);

  const db = getDb();

  const result = db
    .prepare(
      'UPDATE users SET mfa_enabled=0, mfa_backup_email=NULL, is_locked=0, failed_login_attempts=0 WHERE is_admin=1'
    )
    .run();

  if (result.changes === 0) {
    console.log('No admin account found — nothing was changed.');
  } else {
    console.log('Admin 2FA disabled and account unlocked.');
  }

  closeDb();
}

main();
