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

/** Parse an assigned_date string (YYYY-MM-DD or ISO datetime) to a Date object. */
function parseAssignedDate(d: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T00:00:00' : d);
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
  const byDowPersonalByCategory: Record<number, Record<string, number>> = {};
  const byDowPersonalBySubcategory: Record<number, Record<string, number>> = {};
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

    }

    if (t.assigned_date) {
      const assignedDow = parseAssignedDate(t.assigned_date).getDay();
      if (!byDowBySubcategory[assignedDow]) byDowBySubcategory[assignedDow] = {};
      byDowBySubcategory[assignedDow][sub] = (byDowBySubcategory[assignedDow][sub] || 0) + 1;

      if (t.is_duty === 0) {
        if (!byDowPersonalByCategory[assignedDow]) byDowPersonalByCategory[assignedDow] = {};
        byDowPersonalByCategory[assignedDow][cat] = (byDowPersonalByCategory[assignedDow][cat] || 0) + 1;

        if (!byDowPersonalBySubcategory[assignedDow]) byDowPersonalBySubcategory[assignedDow] = {};
        byDowPersonalBySubcategory[assignedDow][sub] = (byDowPersonalBySubcategory[assignedDow][sub] || 0) + 1;
      }
    }

    if (!bySubcategory[sub]) bySubcategory[sub] = { count: 0, minutes: 0 };
    bySubcategory[sub].count++;
    bySubcategory[sub].minutes += mins(t.start_time, t.end_time, t.interruptions);

    if (!byCategoryBySubcategory[cat]) byCategoryBySubcategory[cat] = {};
    byCategoryBySubcategory[cat][sub] = (byCategoryBySubcategory[cat][sub] || 0) + 1;

    if (!byOutcomeByCategory[out]) byOutcomeByCategory[out] = {};
    byOutcomeByCategory[out][cat] = (byOutcomeByCategory[out][cat] || 0) + 1;

    if (t.assigned_date && t.start_time) {
      const aMs = parseAssignedDate(t.assigned_date).getTime();
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
    byDowBySubcategory, byDowPersonalByCategory, byDowPersonalBySubcategory,
    byCategoryBySubcategory, byFlagByCategory, byOutcomeByCategory,
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

router.get('/report', async (req: Request, res: Response) => {
  const s = req.session as any;
  const db = getDb();
  const { mode, from, to, is_duty, category, subcategory, outcome } = req.query as Record<string, string>;

  let raw: any[];
  if (mode === 'session') {
    const dateStr = s.sessionDate || new Date().toISOString().split('T')[0];
    raw = (db.prepare(
      `SELECT * FROM tasks WHERE user_id=? AND status='completed' AND date(start_time)=? ORDER BY start_time`
    ).all(s.userId, dateStr) as any[]).map(t => ({ ...t, interruptions: JSON.parse(t.interruptions || '[]') }));
  } else {
    let q = `SELECT * FROM tasks WHERE user_id=? AND status='completed' AND start_time>=datetime('now','-30 days')`;
    const p: any[] = [s.userId];
    if (from)                              { q += ' AND date(start_time)>=?'; p.push(from); }
    if (to)                                { q += ' AND date(start_time)<=?'; p.push(to); }
    if (is_duty !== undefined && is_duty !== '') { q += ' AND is_duty=?'; p.push(is_duty === 'true' ? 1 : 0); }
    if (category)                          { q += ' AND category=?'; p.push(category); }
    if (subcategory)                       { q += ' AND subcategory=?'; p.push(subcategory); }
    if (outcome)                           { q += ' AND outcome=?'; p.push(outcome); }
    q += ' ORDER BY start_time';
    raw = (db.prepare(q).all(...p) as any[]).map(t => ({ ...t, interruptions: JSON.parse(t.interruptions || '[]') }));
  }

  const tasks = attachFlagLabels(db, raw);
  const sum = buildSummary(tasks);

  // Interruptions per date (for Interruptions Over Time sheet)
  const intrByDate: Record<string, number> = {};
  for (const t of tasks) {
    const d = (t.start_time || '').split('T')[0];
    if (d) intrByDate[d] = (intrByDate[d] || 0) + (t.interruptions?.length || 0);
  }

  const wb = new ExcelJS.Workbook();

  function styleHeader(ws: ExcelJS.Worksheet) {
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };
  }

  function addCrossTabSheet(
    name: string,
    rowLabels: string[],
    colLabels: string[],
    getData: (row: string, col: string) => number,
    rowHeader: string
  ) {
    if (rowLabels.length === 0 || colLabels.length === 0) return;
    const ws = wb.addWorksheet(name);
    ws.columns = [
      { header: rowHeader, key: '__row', width: 28 },
      ...colLabels.map(c => ({ header: c, key: c, width: 18 })),
    ];
    for (const row of rowLabels) {
      const r: Record<string, any> = { __row: row };
      for (const col of colLabels) r[col] = getData(row, col);
      ws.addRow(r);
    }
    styleHeader(ws);
  }

  // 1. Summary
  {
    const ws = wb.addWorksheet('Summary');
    ws.columns = [
      { header: 'Metric', key: 'Metric', width: 32 },
      { header: 'Value',  key: 'Value',  width: 16 },
    ];
    ws.addRows([
      { Metric: 'Total tasks',                 Value: sum.total },
      { Metric: 'Total minutes',               Value: sum.totalMins },
      { Metric: 'Avg minutes per task',        Value: sum.avgDurMins },
      { Metric: 'My Group tasks',              Value: sum.dutyCount },
      { Metric: 'My Group minutes',            Value: sum.dutyMins },
      { Metric: 'Personal tasks',              Value: sum.personalCount },
      { Metric: 'Personal minutes',            Value: sum.personalMins },
      { Metric: 'Total interruptions',         Value: sum.totalInterruptions },
      { Metric: 'Tasks with interruptions',    Value: sum.tasksWithInterruptions },
      { Metric: 'Avg interruptions per task',  Value: sum.avgInterruptionsPerTask },
      { Metric: 'Flagged tasks',               Value: sum.tasksWithFlags },
    ]);
    styleHeader(ws);
  }

  // 2. Time by Category
  {
    const cats = Object.keys(sum.byCategory);
    if (cats.length > 0) {
      const ws = wb.addWorksheet('Time by Category');
      ws.columns = [
        { header: 'Category',      key: 'Category', width: 28 },
        { header: 'Task Count',    key: 'Count',    width: 14 },
        { header: 'Total Minutes', key: 'Minutes',  width: 16 },
        { header: 'Avg Minutes',   key: 'AvgMins',  width: 16 },
      ];
      for (const cat of cats) {
        const v = sum.byCategory[cat];
        ws.addRow({ Category: cat, Count: v.count, Minutes: v.minutes, AvgMins: v.count > 0 ? Math.round(v.minutes / v.count) : 0 });
      }
      styleHeader(ws);
    }
  }

  // 3. Duty vs Personal
  {
    const ws = wb.addWorksheet('Duty vs Personal');
    ws.columns = [
      { header: 'Type',          key: 'Type',    width: 16 },
      { header: 'Task Count',    key: 'Count',   width: 14 },
      { header: 'Total Minutes', key: 'Minutes', width: 16 },
    ];
    ws.addRows([
      { Type: 'My Group', Count: sum.dutyCount,     Minutes: sum.dutyMins },
      { Type: 'Personal', Count: sum.personalCount, Minutes: sum.personalMins },
    ]);
    styleHeader(ws);
  }

  // 4. Outcome Distribution
  {
    const outcomes = Object.keys(sum.byOutcome);
    if (outcomes.length > 0) {
      const ws = wb.addWorksheet('Outcome Distribution');
      ws.columns = [
        { header: 'Outcome', key: 'Outcome', width: 20 },
        { header: 'Count',   key: 'Count',   width: 12 },
      ];
      for (const out of outcomes) ws.addRow({ Outcome: out, Count: sum.byOutcome[out] });
      styleHeader(ws);
    }
  }

  // 5. Outcome by Category
  {
    const cats = Object.keys(sum.byCategory);
    const outcomes = Object.keys(sum.byOutcome);
    if (cats.length > 1 && outcomes.length > 0) {
      addCrossTabSheet(
        'Outcome by Category',
        cats, outcomes,
        (cat, out) => (sum.byOutcomeByCategory[out]?.[cat] || 0),
        'Category'
      );
    }
  }

  // 6. Avg Duration (Category)
  {
    const cats = Object.keys(sum.byCategory);
    if (cats.length > 0) {
      const ws = wb.addWorksheet('Avg Duration (Category)');
      ws.columns = [
        { header: 'Category',    key: 'Category', width: 28 },
        { header: 'Avg Minutes', key: 'AvgMins',  width: 16 },
      ];
      for (const cat of cats) {
        const v = sum.byCategory[cat];
        ws.addRow({ Category: cat, AvgMins: v.count > 0 ? Math.round(v.minutes / v.count) : 0 });
      }
      styleHeader(ws);
    }
  }

  // 7. Tasks by Type
  {
    const subs = Object.keys(sum.bySubcategory);
    if (subs.length > 0) {
      const ws = wb.addWorksheet('Tasks by Type');
      ws.columns = [
        { header: 'Task Type',     key: 'Type',    width: 28 },
        { header: 'Count',         key: 'Count',   width: 12 },
        { header: 'Total Minutes', key: 'Minutes', width: 16 },
        { header: 'Avg Minutes',   key: 'AvgMins', width: 16 },
      ];
      for (const sub of subs) {
        const v = sum.bySubcategory[sub];
        ws.addRow({ Type: sub, Count: v.count, Minutes: v.minutes, AvgMins: v.count > 0 ? Math.round(v.minutes / v.count) : 0 });
      }
      styleHeader(ws);
    }
  }

  // 8. Avg Duration (Task Type)
  {
    const subs = Object.keys(sum.avgDurBySubcategory);
    if (subs.length > 0) {
      const ws = wb.addWorksheet('Avg Duration (Task Type)');
      ws.columns = [
        { header: 'Task Type',   key: 'Type',    width: 28 },
        { header: 'Avg Minutes', key: 'AvgMins', width: 16 },
      ];
      for (const sub of subs) ws.addRow({ Type: sub, AvgMins: sum.avgDurBySubcategory[sub] });
      styleHeader(ws);
    }
  }

  // 9. Task Types by Source Group
  {
    const cats = Object.keys(sum.byCategoryBySubcategory);
    const allSubs = [...new Set(cats.flatMap(c => Object.keys(sum.byCategoryBySubcategory[c])))];
    const hasMeaningful = cats.length > 1 || cats.some(c => Object.keys(sum.byCategoryBySubcategory[c]).length > 1);
    if (hasMeaningful && allSubs.length > 0) {
      addCrossTabSheet(
        'Task Types by Source Group',
        cats, allSubs,
        (cat, sub) => (sum.byCategoryBySubcategory[cat]?.[sub] || 0),
        'Category'
      );
    }
  }

  // 10. Flag Distribution
  {
    const flags = Object.keys(sum.byFlag);
    if (flags.length > 0) {
      const ws = wb.addWorksheet('Flag Distribution');
      ws.columns = [
        { header: 'Flag',  key: 'Flag',  width: 28 },
        { header: 'Count', key: 'Count', width: 12 },
      ];
      for (const flag of flags) ws.addRow({ Flag: flag, Count: sum.byFlag[flag] });
      styleHeader(ws);
    }
  }

  // 11. Flags by Source Group
  {
    const flags = Object.keys(sum.byFlagByCategory);
    if (flags.length > 0) {
      const allCats = [...new Set(flags.flatMap(f => Object.keys(sum.byFlagByCategory[f])))];
      addCrossTabSheet(
        'Flags by Source Group',
        flags, allCats,
        (flag, cat) => (sum.byFlagByCategory[flag]?.[cat] || 0),
        'Flag'
      );
    }
  }

  // 12. Activity by Hour
  {
    const anyHour = Object.keys(sum.byHour).length > 0;
    if (anyHour) {
      const ws = wb.addWorksheet('Activity by Hour');
      ws.columns = [
        { header: 'Hour',          key: 'Hour',    width: 12 },
        { header: 'Task Count',    key: 'Count',   width: 14 },
        { header: 'Total Minutes', key: 'Minutes', width: 16 },
      ];
      for (let h = 0; h < 24; h++) {
        const label = h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`;
        const v = sum.byHour[h] || { count: 0, minutes: 0 };
        ws.addRow({ Hour: label, Count: v.count, Minutes: v.minutes });
      }
      styleHeader(ws);
    }
  }

  // 13. Activity by Day of Week
  {
    const dowFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const anyDow = Object.keys(sum.byDayOfWeek).length > 0;
    if (anyDow) {
      const ws = wb.addWorksheet('Activity by Day of Week');
      ws.columns = [
        { header: 'Day',           key: 'Day',     width: 14 },
        { header: 'Task Count',    key: 'Count',   width: 14 },
        { header: 'Total Minutes', key: 'Minutes', width: 16 },
      ];
      for (let i = 0; i < 7; i++) {
        const v = sum.byDayOfWeek[i] || { count: 0, minutes: 0 };
        ws.addRow({ Day: dowFull[i], Count: v.count, Minutes: v.minutes });
      }
      styleHeader(ws);
    }
  }

  // 14. Task Types by Day Assigned
  {
    const dowFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const allDowSubs = [...new Set(Object.values(sum.byDowBySubcategory).flatMap(v => Object.keys(v)))];
    if (allDowSubs.length > 1) {
      addCrossTabSheet(
        'Task Types by Day Assigned',
        dowFull, allDowSubs,
        (day, sub) => (sum.byDowBySubcategory[dowFull.indexOf(day)]?.[sub] || 0),
        'Day'
      );
    }
  }

  // 15. Personal by Day (Origin)
  {
    const dowFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const allCats = [...new Set(Object.values(sum.byDowPersonalByCategory).flatMap(v => Object.keys(v)))];
    if (allCats.length > 0) {
      addCrossTabSheet(
        'Personal by Day (Origin)',
        dowFull, allCats,
        (day, cat) => (sum.byDowPersonalByCategory[dowFull.indexOf(day)]?.[cat] || 0),
        'Day'
      );
    }
  }

  // 16. Personal by Day (Type)
  {
    const dowFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const allSubs = [...new Set(Object.values(sum.byDowPersonalBySubcategory).flatMap(v => Object.keys(v)))];
    if (allSubs.length > 0) {
      addCrossTabSheet(
        'Personal by Day (Type)',
        dowFull, allSubs,
        (day, sub) => (sum.byDowPersonalBySubcategory[dowFull.indexOf(day)]?.[sub] || 0),
        'Day'
      );
    }
  }

  // 17. Tasks Over Time
  {
    if (sum.dates.length > 1) {
      const ws = wb.addWorksheet('Tasks Over Time');
      const cols: Partial<ExcelJS.Column>[] = [
        { header: 'Date',           key: 'Date',     width: 14, style: { numFmt: 'yyyy-mm-dd' } },
        { header: 'Task Count',     key: 'Count',    width: 14 },
        { header: 'Total Minutes',  key: 'Minutes',  width: 16 },
        { header: 'Duty Tasks',     key: 'Duty',     width: 14 },
        { header: 'Personal Tasks', key: 'Personal', width: 16 },
      ];
      if (sum.regression) cols.push({ header: 'Trend (regression)', key: 'Trend', width: 20 });
      ws.columns = cols;
      sum.dates.forEach((d, i) => {
        const v = sum.byDate[d];
        const row: Record<string, any> = {
          Date:     new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T00:00:00' : d),
          Count:    v.count,
          Minutes:  v.minutes,
          Duty:     v.duty,
          Personal: v.personal,
        };
        if (sum.regression) row.Trend = Math.round((sum.regression.slope * i + sum.regression.intercept) * 10) / 10;
        ws.addRow(row);
      });
      styleHeader(ws);
    }
  }

  // 18. Interruptions Over Time
  {
    if (sum.dates.length > 1) {
      const ws = wb.addWorksheet('Interruptions Over Time');
      ws.columns = [
        { header: 'Date',               key: 'Date',  width: 14, style: { numFmt: 'yyyy-mm-dd' } },
        { header: 'Interruption Count', key: 'Count', width: 20 },
      ];
      for (const d of sum.dates) {
        ws.addRow({
          Date:  new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T00:00:00' : d),
          Count: intrByDate[d] || 0,
        });
      }
      styleHeader(ws);
    }
  }

  // 19. Assignment Lag
  {
    if (sum.lagStats && sum.lagStats.count > 0) {
      const lagBucketOrder = ['0','1','2','3','4','5','6','7','8–14','15–30','>30'];
      const ws = wb.addWorksheet('Assignment Lag');
      ws.columns = [
        { header: 'Days from Assignment', key: 'Days',     width: 22 },
        { header: 'My Group Count',       key: 'Duty',     width: 18 },
        { header: 'Personal Count',       key: 'Personal', width: 18 },
        { header: 'All Tasks',            key: 'All',      width: 14 },
      ];
      ws.addRows([
        { Days: 'Count',         Duty: sum.lagStatsDuty?.count   ?? '', Personal: sum.lagStatsPersonal?.count   ?? '', All: sum.lagStats.count },
        { Days: 'Average (days)', Duty: sum.lagStatsDuty?.avg     ?? '', Personal: sum.lagStatsPersonal?.avg     ?? '', All: sum.lagStats.avg },
        { Days: 'Median (days)', Duty: sum.lagStatsDuty?.median  ?? '', Personal: sum.lagStatsPersonal?.median  ?? '', All: sum.lagStats.median },
        { Days: 'Min (days)',    Duty: sum.lagStatsDuty?.min     ?? '', Personal: sum.lagStatsPersonal?.min     ?? '', All: sum.lagStats.min },
        { Days: 'Max (days)',    Duty: sum.lagStatsDuty?.max     ?? '', Personal: sum.lagStatsPersonal?.max     ?? '', All: sum.lagStats.max },
        { Days: '',              Duty: '',                              Personal: '',                                  All: '' },
        { Days: 'Lag Distribution', Duty: '', Personal: '', All: '' },
      ]);
      for (const bucket of lagBucketOrder) {
        const dutyVal    = sum.lagStatsDuty?.buckets[bucket];
        const personalVal = sum.lagStatsPersonal?.buckets[bucket];
        const allVal     = sum.lagStats.buckets[bucket];
        if (dutyVal !== undefined || personalVal !== undefined || allVal !== undefined) {
          ws.addRow({ Days: bucket, Duty: dutyVal || 0, Personal: personalVal || 0, All: allVal || 0 });
        }
      }
      styleHeader(ws);
    }
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  const filename = `Tasker-Analytics-${stamp}.xlsx`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Last-Modified', now.toUTCString());
  await wb.xlsx.write(res);
  res.end();
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
