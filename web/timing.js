// Review-plan timing helpers: average wait until the next review, calendar
// buckets and how the average moved over the last day and week.
// `schedules` is an object keyed by card id with a numeric `due` timestamp;
// a card without a schedule is new.
const DAY_MS = 24 * 60 * 60 * 1000;

function isNew(schedule) {
  return !schedule || !schedule.due;
}

function startOfDay(now, offsetDays) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return date.getTime();
}

export function buildTimingStats({ cards, schedules, now = new Date() }) {
  const nowMs = now.getTime();
  const remaining = cards.map((card) => {
    const schedule = schedules[card.id];
    if (isNew(schedule)) return 0;
    return Math.max(0, schedule.due - nowMs);
  });
  const total = remaining.length;
  return {
    total,
    newCount: cards.filter((card) => isNew(schedules[card.id])).length,
    dueCount: cards.filter((card) => !isNew(schedules[card.id]) && schedules[card.id].due <= nowMs).length,
    averageRemainingMs: total ? remaining.reduce((sum, value) => sum + value, 0) / total : 0
  };
}

export function buildDueBuckets({ cards, schedules, now = new Date() }) {
  const tomorrow = startOfDay(now, 1);
  const inTwoDays = startOfDay(now, 2);
  const inSixteenDays = startOfDay(now, 16);
  const buckets = { today: 0, tomorrow: 0, days2to15: 0, later: 0, total: cards.length };
  for (const card of cards) {
    const schedule = schedules[card.id];
    if (isNew(schedule) || schedule.due < tomorrow) buckets.today += 1;
    else if (schedule.due < inTwoDays) buckets.tomorrow += 1;
    else if (schedule.due < inSixteenDays) buckets.days2to15 += 1;
    else buckets.later += 1;
  }
  return buckets;
}

function averageRemainingAt({ cards, schedules, logs, cutoff, now }) {
  if (!cards.length) return 0;
  const firstAfter = new Map();
  for (const log of logs || []) {
    const at = Number(log.reviewedAt);
    if (!Number.isFinite(at) || at <= cutoff || at > now) continue;
    const current = firstAfter.get(log.cardId);
    if (!current || at < current.at) firstAfter.set(log.cardId, { log, at });
  }
  const total = cards.reduce((sum, card) => {
    const first = firstAfter.get(card.id)?.log;
    if (first?.wasNew) return sum;
    if (!first && isNew(schedules[card.id])) return sum;
    const due = first ? Number(first.dueBefore) : schedules[card.id].due;
    if (!Number.isFinite(due)) return sum;
    return sum + Math.max(0, due - cutoff);
  }, 0);
  return total / cards.length;
}

export function buildTimingChanges({ cards, schedules, logs, now = new Date() }) {
  const nowMs = now.getTime();
  const current = buildTimingStats({ cards, schedules, now }).averageRemainingMs;
  return {
    dayDeltaMs: current - averageRemainingAt({ cards, schedules, logs, cutoff: nowMs - DAY_MS, now: nowMs }),
    weekDeltaMs: current - averageRemainingAt({ cards, schedules, logs, cutoff: nowMs - 7 * DAY_MS, now: nowMs })
  };
}

/** `t(key, vars)` is the interface translator; `n` is a two-decimal string. */
export function formatTiming(stats, t) {
  if (!stats?.total) return t("an.now");
  if (stats.averageRemainingMs < 60 * 1000) return stats.dueCount ? t("an.zeroDays") : t("an.now");
  const days = stats.averageRemainingMs / DAY_MS;
  if (days >= 1) return t("an.inDays", { n: days.toFixed(2) });
  const hours = stats.averageRemainingMs / (60 * 60 * 1000);
  if (hours >= 1) return t("an.inHours", { n: hours.toFixed(2) });
  return t("an.inMinutes", { n: (stats.averageRemainingMs / 60000).toFixed(2) });
}
