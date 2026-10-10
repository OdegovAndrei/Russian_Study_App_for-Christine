import test from "node:test";
import assert from "node:assert/strict";
import { buildTimingStats, buildDueBuckets, buildTimingChanges, formatTiming } from "../web/timing.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 0, 10, 12, 0, 0);
const cards = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

test("new cards count as due today and have no remaining time", () => {
  const schedules = { a: { due: NOW.getTime() - 1000 }, b: { due: NOW.getTime() + 2 * DAY } };
  const stats = buildTimingStats({ cards, schedules, now: NOW });
  assert.equal(stats.total, 4);
  assert.equal(stats.newCount, 2);
  assert.equal(stats.dueCount, 1);
  assert.equal(stats.averageRemainingMs, (2 * DAY) / 4);
});

test("buckets split by calendar day", () => {
  const schedules = {
    a: { due: NOW.getTime() - 1000 },
    b: { due: new Date(2026, 0, 11, 9).getTime() },
    c: { due: new Date(2026, 0, 20, 9).getTime() },
    d: { due: new Date(2026, 1, 20, 9).getTime() }
  };
  assert.deepEqual(buildDueBuckets({ cards, schedules, now: NOW }), { today: 1, tomorrow: 1, days2to15: 1, later: 1, total: 4 });
});

test("a good review raises the average compared with a day ago", () => {
  const reviewedAt = NOW.getTime() - 2 * 60 * 60 * 1000;
  const schedules = { a: { due: NOW.getTime() + 3 * DAY }, b: { due: NOW.getTime() + DAY } };
  const logs = [{ cardId: "a", reviewedAt, dueBefore: reviewedAt - 1000, dueAfter: NOW.getTime() + 3 * DAY, wasNew: false, rating: "good" }];
  const changes = buildTimingChanges({ cards: [{ id: "a" }, { id: "b" }], schedules, logs, now: NOW });
  assert.ok(changes.dayDeltaMs > 0);
});

test("formatTiming picks days, hours or minutes", () => {
  const t = (key, vars) => `${key}:${vars?.n ?? ""}`;
  assert.equal(formatTiming({ total: 0 }, t), "an.now:");
  assert.equal(formatTiming({ total: 1, averageRemainingMs: 2 * DAY }, t), "an.inDays:2.00");
  assert.equal(formatTiming({ total: 1, averageRemainingMs: 3 * 60 * 60 * 1000 }, t), "an.inHours:3.00");
  assert.equal(formatTiming({ total: 1, averageRemainingMs: 30 * 60 * 1000 }, t), "an.inMinutes:30.00");
});
