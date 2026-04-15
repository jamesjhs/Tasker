import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { requireAuth, requirePasswordChange, requireActivation } from '../middleware/index';
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
  const byHour: Record<number, { count: number; minutes: number }> = {};
  const byDayOfWeek: Record<number, { count: number; minutes: number }> = {};
  const bySubcategory: Record<string, { count: number; minutes: number }> = {};
  const interruptionsByCategory: Record<string, number> = {};
  const byDowBySubcategory: Record<number, Record<string, number>> = {};
  const byCategoryBySubcategory: Record<string, Record<string, number>> = {};
  const byFlagByCategory: Record<string, Record<string, number>> = {};
  const byOutcomeByCategory: Record<string, Record<string, number>> = {};
  const assignedLagDays: number[] = [];
  const assignedLagDaysDuty: number[] = [];
  const assignedLagDaysPersonal: number[] = [];

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

    const sub = t.subcategory || 'Unspecified';
    if (t.start_time) {
      const h = new Date(t.start_time).getHours();
      if (!byHour[h]) byHour[h] = { count: 0, minutes: 0 };
      byHour[h].count++;
      byHour[h].minutes += mins(t.start_time, t.end_time, t.interruptions);

      const dow = new Date(t.start_time).getDay();
      if (!byDayOfWeek[dow]) byDayOfWeek[dow] = { count: 0, minutes: 0 };
      byDayOfWeek[dow].count++;
      byDayOfWeek[dow].minutes += mins(t.start_time, t.end_time, t.interruptions);

      if (!byDowBySubcategory[dow]) byDowBySubcategory[dow] = {};
      byDowBySubcategory[dow][sub] = (byDowBySubcategory[dow][sub] || 0) + 1;
    }

    if (!bySubcategory[sub]) bySubcategory[sub] = { count: 0, minutes: 0 };
    bySubcategory[sub].count++;
    bySubcategory[sub].minutes += mins(t.start_time, t.end_time, t.interruptions);

    if (!byCategoryBySubcategory[cat]) byCategoryBySubcategory[cat] = {};
    byCategoryBySubcategory[cat][sub] = (byCategoryBySubcategory[cat][sub] || 0) + 1;

    if (!byOutcomeByCategory[out]) byOutcomeByCategory[out] = {};
    byOutcomeByCategory[out][cat] = (byOutcomeByCategory[out][cat] || 0) + 1;

    if (t.assigned_date && t.start_time) {
      const aMs = new Date(/^\d{4}-\d{2}-\d{2}$/.test(t.assigned_date) ? t.assigned_date + 'T00:00:00' : t.assigned_date).getTime();
      const sMs = new Date(t.start_time).getTime();
      const lagDay = Math.max(0, Math.floor((sMs - aMs) / 86400000));
      assignedLagDays.push(lagDay);
      if (t.is_duty === 1) assignedLagDaysDuty.push(lagDay);
      else assignedLagDaysPersonal.push(lagDay);
    }

    interruptionsByCategory[cat] = (interruptionsByCategory[cat] || 0) + (t.interruptions?.length || 0);
  }

  // Flag breakdown
  const byFlag: Record<string, number> = {};
  for (const t of tasks) {
    const tCat = t.category || 'Uncategorised';
    for (const f of (t.flag_labels || [])) {
      byFlag[f] = (byFlag[f] || 0) + 1;
      if (!byFlagByCategory[f]) byFlagByCategory[f] = {};
      byFlagByCategory[f][tCat] = (byFlagByCategory[f][tCat] || 0) + 1;
    }
  }
  const tasksWithFlags = tasks.filter(t => (t.flag_labels?.length || 0) > 0).length;

  // Lag stats helper: days between assigned_date and start_time
  function computeLagStats(days: number[]) {
    if (days.length === 0) return null;
    const sorted = [...days].sort((a, b) => a - b);
    const n = sorted.length;
    const lagAvg = Math.round(sorted.reduce((s, d) => s + d, 0) / n * 10) / 10;
    const lagMedian = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
    const p75 = sorted[Math.floor(n * 0.75)];
    const buckets: Record<string, number> = {};
    for (const d of sorted) {
      let b: string;
      if (d <= 7) { b = String(d); }
      else if (d <= 14) { b = '8–14'; }
      else if (d <= 30) { b = '15–30'; }
      else { b = '>30'; }
      buckets[b] = (buckets[b] || 0) + 1;
    }
    return { count: n, avg: lagAvg, median: lagMedian, min: sorted[0], max: sorted[n - 1], p75, buckets };
  }
  const lagStats = computeLagStats(assignedLagDays);
  const lagStatsDuty = computeLagStats(assignedLagDaysDuty);
  const lagStatsPersonal = computeLagStats(assignedLagDaysPersonal);

  // Avg duration per subcategory (minutes)
  const avgDurBySubcategory: Record<string, number> = {};
  for (const [k, v] of Object.entries(bySubcategory)) {
    avgDurBySubcategory[k] = v.count > 0 ? Math.round(v.minutes / v.count) : 0;
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
  const tasksWithInterruptions = tasks.filter(t => (t.interruptions?.length || 0) > 0).length;
  const avgDurMins = tasks.length > 0 ? Math.round(totalMins / tasks.length) : 0;
  const avgInterruptionsPerTask = tasks.length > 0
    ? Math.round((totalInterruptions / tasks.length) * 10) / 10
    : 0;

  return {
    total: tasks.length,
    totalMins,
    totalInterruptions,
    tasksWithInterruptions,
    avgDurMins,
    avgInterruptionsPerTask,
    dutyCount: duty.length,
    dutyMins: duty.reduce((s, t) => s + mins(t.start_time, t.end_time, t.interruptions), 0),
    personalCount: personal.length,
    personalMins: personal.reduce((s, t) => s + mins(t.start_time, t.end_time, t.interruptions), 0),
    byCategory, byOutcome, byDate, byHour, byDayOfWeek, bySubcategory, interruptionsByCategory,
    byFlag, tasksWithFlags,
    byDowBySubcategory, byCategoryBySubcategory, byFlagByCategory, byOutcomeByCategory,
    lagStats, lagStatsDuty, lagStatsPersonal, avgDurBySubcategory,
    dates, regression,
  };
}

/** Batch-fetch flag labels for an array of tasks. Returns the same tasks with flag_labels populated. */
function attachFlagLabels(db: ReturnType<typeof getDb>, tasks: any[]): any[] {
  if (tasks.length === 0) return tasks;
  const placeholders = tasks.map(() => '?').join(',');
  const flagRows = db.prepare(
    `SELECT tf.task_id, tfo.value FROM task_flags tf
     JOIN task_flag_options tfo ON tfo.id=tf.flag_option_id
     WHERE tf.task_id IN (${placeholders})`
  ).all(...tasks.map(t => t.id)) as { task_id: number; value: string }[];
  const flagMap = new Map<number, string[]>();
  for (const r of flagRows) {
    if (!flagMap.has(r.task_id)) flagMap.set(r.task_id, []);
    flagMap.get(r.task_id)!.push(r.value);
  }
  return tasks.map(t => ({ ...t, flag_labels: flagMap.get(t.id) || [] }));
}

router.get('/session', (req: Request, res: Response) => {
  const s = req.session as any;
  const db = getDb();
  const dateStr = s.sessionDate || new Date().toISOString().split('T')[0];
  const raw = (db.prepare(
    `SELECT * FROM tasks WHERE user_id=? AND status='completed' AND date(start_time)=? ORDER BY start_time`
  ).all(s.userId, dateStr) as any[]).map(t => ({ ...t, interruptions: JSON.parse(t.interruptions || '[]') }));
  const tasks = attachFlagLabels(db, raw);
  res.json({ tasks, summary: buildSummary(tasks) });
});

router.get('/history', (req: Request, res: Response) => {
  const s = req.session as any;
  const { from, to, is_duty, category, subcategory, outcome } = req.query as Record<string, string>;
  let q = `SELECT * FROM tasks WHERE user_id=? AND status='completed' AND start_time>=datetime('now','-30 days')`;
  const p: any[] = [s.userId];
  if (from)                  { q += ' AND date(start_time)>=?'; p.push(from); }
  if (to)                    { q += ' AND date(start_time)<=?'; p.push(to); }
  if (is_duty !== undefined) { q += ' AND is_duty=?'; p.push(is_duty === 'true' ? 1 : 0); }
  if (category)              { q += ' AND category=?'; p.push(category); }
  if (subcategory)           { q += ' AND subcategory=?'; p.push(subcategory); }
  if (outcome)               { q += ' AND outcome=?'; p.push(outcome); }
  q += ' ORDER BY start_time';
  const db = getDb();
  const raw = (db.prepare(q).all(...p) as any[]).map(t => ({ ...t, interruptions: JSON.parse(t.interruptions || '[]') }));
  const tasks = attachFlagLabels(db, raw);
  res.json({ tasks, summary: buildSummary(tasks) });
});

router.get('/export', async (req: Request, res: Response) => {
  const s = req.session as any;
  const db = getDb();
  const raw = (db.prepare(
    `SELECT * FROM tasks WHERE user_id=? AND status='completed' AND start_time>=datetime('now','-30 days') ORDER BY start_time`
  ).all(s.userId) as any[]).map(t => ({ ...t, interruptions: JSON.parse(t.interruptions || '[]') }));
  const tasksWithFlags = attachFlagLabels(db, raw);
  const tasks = tasksWithFlags.map(t => ({
    'Type': t.is_duty ? 'Duty' : 'Personal',
    'Task From': t.category || '',
    'Task Type': t.subcategory || '',
    'Outcome': t.outcome || '',
    'Date Assigned': t.assigned_date ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(t.assigned_date) ? t.assigned_date + 'T00:00:00' : t.assigned_date) : '',
    'Start Time': t.start_time ? new Date(t.start_time) : '',
    'End Time': t.end_time ? new Date(t.end_time) : '',
    'Duration (secs)': secs(t.start_time, t.end_time, t.interruptions),
    'Interruptions': t.interruptions.length,
    'Flags': (t.flag_labels as string[]).join('; '),
  }));

  const pendingLog = db.prepare(
    `SELECT count, logged_at FROM pending_task_logs WHERE user_id=? ORDER BY logged_at DESC LIMIT 1`
  ).get(s.userId) as any;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tasks');
  ws.columns = [
    { header: 'Type',            key: 'Type',            width: 12 },
    { header: 'Task From',       key: 'Task From',       width: 22 },
    { header: 'Task Type',       key: 'Task Type',       width: 22 },
    { header: 'Outcome',         key: 'Outcome',         width: 16 },
    { header: 'Date Assigned',   key: 'Date Assigned',   width: 16, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Start Time',      key: 'Start Time',      width: 22, style: { numFmt: 'yyyy-mm-dd hh:mm:ss' } },
    { header: 'End Time',        key: 'End Time',        width: 22, style: { numFmt: 'yyyy-mm-dd hh:mm:ss' } },
    { header: 'Duration (secs)', key: 'Duration (secs)', width: 16 },
    { header: 'Interruptions',   key: 'Interruptions',   width: 14 },
    { header: 'Flags',           key: 'Flags',           width: 40 },
  ];
  ws.addRows(tasks);

  const ws2 = wb.addWorksheet('Summary');
  ws2.columns = [
    { header: 'Metric', key: 'Metric', width: 28 },
    { header: 'Value',  key: 'Value',  width: 20 },
  ];
  ws2.addRows([
    { 'Metric': 'Pending tasks (last logged)', 'Value': pendingLog ? pendingLog.count : '' },
    { 'Metric': 'Pending tasks logged at',     'Value': pendingLog ? new Date(pendingLog.logged_at) : '' },
  ]);
  ws2.getCell('B2').numFmt = 'yyyy-mm-dd hh:mm';

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  const filename = `Tasker-${stamp}.xlsx`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Last-Modified', now.toUTCString());
  await wb.xlsx.write(res);
  res.end();
});

export default router;
