import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { requireAuth, requirePasswordChange, requireActivation } from '../middleware/index';
import { decryptField } from '../encrypt';
import ExcelJS from 'exceljs';

const router = Router();
router.use(requireAuth);
router.use(requirePasswordChange);
router.use(requireActivation);

function mins(start: string, end: string, interruptions: any[]): number {
  if (!start || !end) return 0;
  let ms = new Date(end).getTime() - new Date(start).getTime();
  for (const i of interruptions) {
    if (i.start && i.end) ms -= new Date(i.end).getTime() - new Date(i.start).getTime();
  }
  return Math.max(0, Math.round(ms / 60000));
}

function secs(start: string, end: string, interruptions: any[]): number {
  if (!start || !end) return 0;
  let ms = new Date(end).getTime() - new Date(start).getTime();
  for (const i of interruptions) {
    if (i.start && i.end) ms -= new Date(i.end).getTime() - new Date(i.start).getTime();
  }
  return Math.max(0, Math.round(ms / 1000));
}

function buildSummary(tasks: any[]) {
  const duty = tasks.filter(t => t.is_duty === 1);
  const personal = tasks.filter(t => t.is_duty === 0);
  const totalMins = tasks.reduce((s, t) => s + mins(t.start_time, t.end_time, t.interruptions), 0);

  const byCategory: Record<string, { count: number; minutes: number }> = {};
  const byOutcome: Record<string, number> = {};
  const byDate: Record<string, { count: number; minutes: number; duty: number; personal: number }> = {};

  for (const t of tasks) {
    const cat = t.category || 'Uncategorised';
    if (!byCategory[cat]) byCategory[cat] = { count: 0, minutes: 0 };
    byCategory[cat].count++;
    byCategory[cat].minutes += mins(t.start_time, t.end_time, t.interruptions);

    const out = t.outcome || 'None';
    byOutcome[out] = (byOutcome[out] || 0) + 1;

    const d = (t.start_time || '').split('T')[0];
    if (d) {
      if (!byDate[d]) byDate[d] = { count: 0, minutes: 0, duty: 0, personal: 0 };
      byDate[d].count++;
      byDate[d].minutes += mins(t.start_time, t.end_time, t.interruptions);
      if (t.is_duty === 1) byDate[d].duty++; else byDate[d].personal++;
    }
  }

  // Linear regression on daily counts
  const dates = Object.keys(byDate).sort();
  let regression: { slope: number; intercept: number; r2: number } | null = null;
  if (dates.length >= 3) {
    const n = dates.length;
    const x = dates.map((_, i) => i);
    const y = dates.map(d => byDate[d].count);
    const xm = x.reduce((a, b) => a + b, 0) / n;
    const ym = y.reduce((a, b) => a + b, 0) / n;
    const ssxy = x.reduce((s, xi, i) => s + (xi - xm) * (y[i] - ym), 0);
    const ssx = x.reduce((s, xi) => s + (xi - xm) ** 2, 0);
    const slope = ssx > 0 ? ssxy / ssx : 0;
    const intercept = ym - slope * xm;
    const ssRes = y.reduce((s, yi, i) => s + (yi - (slope * x[i] + intercept)) ** 2, 0);
    const ssTot = y.reduce((s, yi) => s + (yi - ym) ** 2, 0);
    regression = {
      slope: Math.round(slope * 1000) / 1000,
      intercept: Math.round(intercept * 1000) / 1000,
      r2: Math.round((ssTot > 0 ? 1 - ssRes / ssTot : 0) * 1000) / 1000,
    };
  }

  const totalInterruptions = tasks.reduce((s, t) => s + (t.interruptions?.length || 0), 0);

  return {
    total: tasks.length,
    totalMins,
    totalInterruptions,
    dutyCount: duty.length,
    dutyMins: duty.reduce((s, t) => s + mins(t.start_time, t.end_time, t.interruptions), 0),
    personalCount: personal.length,
    personalMins: personal.reduce((s, t) => s + mins(t.start_time, t.end_time, t.interruptions), 0),
    byCategory, byOutcome, byDate, dates, regression,
  };
}

router.get('/session', (req: Request, res: Response) => {
  const s = req.session as any;
  const dateStr = new Date(s.sessionDate || new Date().toDateString()).toISOString().split('T')[0];
  const tasks = (getDb().prepare(
    `SELECT * FROM tasks WHERE user_id=? AND status='completed' AND date(start_time)=date(?) ORDER BY start_time`
  ).all(s.userId, dateStr) as any[]).map(t => ({ ...t, interruptions: JSON.parse(t.interruptions || '[]'), notes: decryptField(t.notes) }));
  res.json({ tasks, summary: buildSummary(tasks) });
});

router.get('/history', (req: Request, res: Response) => {
  const s = req.session as any;
  const { from, to, is_duty, category, outcome } = req.query as Record<string, string>;
  let q = `SELECT * FROM tasks WHERE user_id=? AND status='completed' AND start_time>=datetime('now','-30 days')`;
  const p: any[] = [s.userId];
  if (from)                  { q += ' AND date(start_time)>=?'; p.push(from); }
  if (to)                    { q += ' AND date(start_time)<=?'; p.push(to); }
  if (is_duty !== undefined) { q += ' AND is_duty=?'; p.push(is_duty === 'true' ? 1 : 0); }
  if (category)              { q += ' AND category=?'; p.push(category); }
  if (outcome)               { q += ' AND outcome=?'; p.push(outcome); }
  q += ' ORDER BY start_time';
  const tasks = (getDb().prepare(q).all(...p) as any[]).map(t => ({ ...t, interruptions: JSON.parse(t.interruptions || '[]'), notes: decryptField(t.notes) }));
  res.json({ tasks, summary: buildSummary(tasks) });
});

router.get('/export', async (req: Request, res: Response) => {
  const ua = req.headers['user-agent'] || '';
  if (!/Mobile|Android|iPhone|iPad|iPod/i.test(ua)) {
    res.status(403).json({ error: 'Export is only available on mobile.' }); return;
  }
  const s = req.session as any;
  const tasks = (getDb().prepare(
    `SELECT * FROM tasks WHERE user_id=? AND status='completed' AND start_time>=datetime('now','-30 days') ORDER BY start_time`
  ).all(s.userId) as any[]).map(t => {
    const interruptions = JSON.parse(t.interruptions || '[]');
    return {
      'Type': t.is_duty ? 'Duty' : 'Personal',
      'Task From': t.category || '',
      'Task Type': t.subcategory || '',
      'Outcome': t.outcome || '',
      'Date Assigned': t.assigned_date ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(t.assigned_date) ? t.assigned_date + 'T00:00:00' : t.assigned_date) : '',
      'Start Time': t.start_time ? new Date(t.start_time) : '',
      'End Time': t.end_time ? new Date(t.end_time) : '',
      'Duration (secs)': secs(t.start_time, t.end_time, interruptions),
      'Interruptions': interruptions.length,
      'Notes': decryptField(t.notes) || '',
    };
  });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tasks');
  ws.columns = [
    { header: 'Type',            key: 'Type',            width: 12 },
    { header: 'Task From',       key: 'Task From',       width: 22 },
    { header: 'Task Type',       key: 'Task Type',       width: 22 },
    { header: 'Outcome',         key: 'Outcome',         width: 16 },
    { header: 'Date Assigned',   key: 'Date Assigned',   width: 16, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Start Time',      key: 'Start Time',      width: 20, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
    { header: 'End Time',        key: 'End Time',        width: 20, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
    { header: 'Duration (secs)', key: 'Duration (secs)', width: 16 },
    { header: 'Interruptions',   key: 'Interruptions',   width: 14 },
    { header: 'Notes',           key: 'Notes',           width: 32 },
  ];
  ws.addRows(tasks);
  res.setHeader('Content-Disposition', 'attachment; filename="tasker-export.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await wb.xlsx.write(res);
  res.end();
});

export default router;
