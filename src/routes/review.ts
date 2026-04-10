import { Router, Request, Response } from 'express';
import { getDb } from '../db';

const router = Router();

const FIELD_LABELS: Record<string, string> = { category: 'Task From', subcategory: 'Task Type', outcome: 'Outcome' };

function reviewPageHtml(opts: { message?: string; error?: string; fieldLabel?: string; type?: string; token?: string; done?: boolean }): string {
  const { message, error, fieldLabel, type, token, done } = opts;
  const msgHtml = message ? `<div class="msg msg-success">${message}</div>` : '';
  const errHtml = error   ? `<div class="msg msg-error">${error}</div>`     : '';
  const label   = type === 'flag' ? 'task flag option' : `option for the <em>${fieldLabel}</em> dropdown`;
  const formHtml = (!done && token) ? `
    <p style="font-size:.9rem;color:#374151;margin-bottom:16px">
      A user has suggested a new ${label}. Enter the approved wording below to add it to the system.
      The value you enter may differ from the suggestion if needed.
    </p>
    <form method="POST" action="/suggest/review">
      <input type="hidden" name="token" value="${token}">
      <label for="value">Approved wording</label>
      <input id="value" type="text" name="value" maxlength="100" required autofocus placeholder="Enter the approved value…">
      <button type="submit">✓ Add to System</button>
    </form>` : '';
  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Review Suggestion — Tasker</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:48px auto;padding:0 20px;color:#111827}
    h1{font-size:1.3rem;margin-bottom:20px;color:#1a56db}
    label{display:block;font-size:.875rem;font-weight:600;margin-bottom:4px;color:#374151}
    input[type=text]{width:100%;padding:10px 12px;font-size:1rem;border:1px solid #d1d5db;border-radius:6px;outline:none}
    input[type=text]:focus{border-color:#1a56db;box-shadow:0 0 0 3px rgba(26,86,219,.15)}
    button{display:block;width:100%;margin-top:14px;padding:12px;background:#1a56db;color:#fff;border:none;border-radius:6px;font-size:1rem;font-weight:600;cursor:pointer}
    button:hover{background:#1e40af}
    .msg{padding:12px 16px;border-radius:6px;margin-bottom:16px;font-size:.9rem}
    .msg-success{background:#d1fae5;color:#065f46}
    .msg-error{background:#fee2e2;color:#991b1b}
    em{font-style:normal;font-weight:600;color:#1a56db}
  </style>
</head><body>
  <h1>📋 Tasker — Review Suggestion</h1>
  ${errHtml}${msgHtml}${formHtml}
</body></html>`;
}

// GET /suggest/review?token=<token> — show review form
router.get('/', (req: Request, res: Response) => {
  const token = (req.query['token'] as string || '').trim();
  if (!token) { res.status(400).send(reviewPageHtml({ error: 'Missing review token.' })); return; }
  const db = getDb();
  const dp = db.prepare('SELECT id, field_name FROM dropdown_proposals WHERE review_token=?').get(token) as { id: number; field_name: string } | undefined;
  if (dp) {
    res.send(reviewPageHtml({ token, type: 'dropdown', fieldLabel: FIELD_LABELS[dp.field_name] || dp.field_name }));
    return;
  }
  const fp = db.prepare('SELECT id FROM flag_proposals WHERE review_token=?').get(token) as { id: number } | undefined;
  if (fp) { res.send(reviewPageHtml({ token, type: 'flag' })); return; }
  res.status(404).send(reviewPageHtml({ error: 'This review link is invalid or has already been used.' }));
});

// POST /suggest/review — process form submission
router.post('/', (req: Request, res: Response) => {
  const { token, value } = req.body as { token?: string; value?: string };
  const t = (token || '').trim();
  const clean = (value || '').trim();
  if (!t) { res.status(400).send(reviewPageHtml({ error: 'Missing token.' })); return; }
  if (!clean || clean.length > 100) { res.status(400).send(reviewPageHtml({ error: 'Please enter a value (max 100 characters).', token: t })); return; }
  const db = getDb();

  // Check dropdown proposals
  const dp = db.prepare('SELECT id, field_name, user_id FROM dropdown_proposals WHERE review_token=?').get(t) as { id: number; field_name: string; user_id: number } | undefined;
  if (dp) {
    const conflict = db.prepare('SELECT id FROM dropdown_options WHERE field_name=? AND value=?').get(dp.field_name, clean);
    if (conflict) {
      res.status(409).send(reviewPageHtml({ error: `"${clean}" already exists in the ${FIELD_LABELS[dp.field_name] || dp.field_name} dropdown.`, token: t, type: 'dropdown', fieldLabel: FIELD_LABELS[dp.field_name] || dp.field_name }));
      return;
    }
    db.transaction(() => {
      const ins = db.prepare('INSERT OR IGNORE INTO dropdown_options (field_name,value,approved) VALUES (?,?,1)').run(dp.field_name, clean);
      if (ins.changes > 0) {
        const newId = ins.lastInsertRowid as number;
        db.prepare('INSERT OR IGNORE INTO group_dropdown_options (group_id, dropdown_option_id) SELECT id,? FROM user_groups').run(newId);
      }
      const msg = `Your suggested option for "${FIELD_LABELS[dp.field_name] || dp.field_name}" has been reviewed and a new option has been added to the list.`;
      db.prepare('INSERT INTO user_messages (user_id, message) VALUES (?,?)').run(dp.user_id, msg);
      db.prepare('DELETE FROM dropdown_proposals WHERE id=?').run(dp.id);
    })();
    res.send(reviewPageHtml({ message: `"${clean}" has been added to the ${FIELD_LABELS[dp.field_name] || dp.field_name} dropdown and assigned to all groups.`, done: true }));
    return;
  }

  // Check flag proposals
  const fp = db.prepare('SELECT id FROM flag_proposals WHERE review_token=?').get(t) as { id: number } | undefined;
  if (fp) {
    const conflict = db.prepare('SELECT id FROM task_flag_options WHERE value=?').get(clean);
    if (conflict) {
      res.status(409).send(reviewPageHtml({ error: `"${clean}" already exists as a flag option.`, token: t, type: 'flag' }));
      return;
    }
    db.prepare('INSERT OR IGNORE INTO task_flag_options (value, approved) VALUES (?,1)').run(clean);
    db.prepare('DELETE FROM flag_proposals WHERE id=?').run(fp.id);
    res.send(reviewPageHtml({ message: `"${clean}" has been added as a task flag option.`, done: true }));
    return;
  }

  res.status(404).send(reviewPageHtml({ error: 'This review link is invalid or has already been used.' }));
});

export default router;
