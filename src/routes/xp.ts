import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { requireAuth, requirePasswordChange, requireActivation } from '../middleware/index';

const router = Router();
router.use(requireAuth);
router.use(requirePasswordChange);
router.use(requireActivation);

/** XP earned = 1 XP per minute of net task duration (interruptions subtracted). */
function calcTaskXp(startTime: string, endTime: string, interruptions: { start?: string; end?: string }[]): number {
  if (!startTime || !endTime) return 0;
  let ms = new Date(endTime).getTime() - new Date(startTime).getTime();
  for (const i of interruptions) {
    if (i.start && i.end) ms -= new Date(i.end).getTime() - new Date(i.start).getTime();
  }
  return Math.max(0, Math.floor(ms / 60000));
}

/**
 * Total XP required to reach level n (1-indexed).
 * Uses a triangular progression: xpThreshold(n) = n*(n-1)/2 * 100
 *   Level 1: 0 XP   Level 2: 100 XP   Level 3: 300 XP   Level 4: 600 XP ...
 */
function xpThreshold(level: number): number {
  return Math.floor(level * (level - 1) / 2 * 100);
}

/** Derive level from total XP using the inverse of the triangular formula. */
function levelForXp(totalXp: number): number {
  if (totalXp <= 0) return 1;
  return Math.max(1, Math.floor((1 + Math.sqrt(1 + 8 * totalXp / 100)) / 2));
}

/** GET /api/xp/summary — returns the current user's XP summary. */
router.get('/summary', (req: Request, res: Response) => {
  const s = req.session as any;
  const db = getDb();

  const tasks = db.prepare(
    `SELECT category, start_time, end_time, interruptions
       FROM tasks
      WHERE user_id=? AND status='completed' AND end_time IS NOT NULL`
  ).all(s.userId) as { category: string | null; start_time: string; end_time: string; interruptions: string }[];

  const xpBySourceMap: Record<string, number> = {};
  let totalXp = 0;

  for (const t of tasks) {
    const interruptions = JSON.parse(t.interruptions || '[]') as { start?: string; end?: string }[];
    const xp = calcTaskXp(t.start_time, t.end_time, interruptions);
    const cat = t.category || 'Uncategorised';
    xpBySourceMap[cat] = (xpBySourceMap[cat] || 0) + xp;
    totalXp += xp;
  }

  const level = levelForXp(totalXp);
  const currentLevelThreshold = xpThreshold(level);
  const nextLevelThreshold = xpThreshold(level + 1);
  const xpInCurrentLevel = totalXp - currentLevelThreshold;
  const xpNeededForNextLevel = nextLevelThreshold - currentLevelThreshold;

  const xpBySource = Object.entries(xpBySourceMap)
    .map(([source, xp]) => ({ source, xp }))
    .sort((a, b) => b.xp - a.xp);

  res.json({
    totalXp,
    level,
    xpInCurrentLevel,
    xpNeededForNextLevel,
    progressPercent: xpNeededForNextLevel > 0
      ? Math.min(100, Math.round(xpInCurrentLevel / xpNeededForNextLevel * 100))
      : 100,
    xpBySource,
  });
});

export default router;
