import test from "node:test";
import assert from "node:assert/strict";
import {
  review, previewIntervals, isNewSchedule, isDueSchedule, isLearningSchedule,
  buildReviewQueue, migrateSchedule, GRADES, MINUTE_MS, DAY_MS
} from "../web/srs.js";

const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);

test("the scheduler is FSRS with 90% retention and learning steps", () => {
  const again = review(null, "again", NOW).schedule;
  assert.equal(isLearningSchedule(again), true);
  assert.ok(again.due - NOW >= 30 * 1000 && again.due - NOW <= 2 * MINUTE_MS, "again returns within about a minute");

  const good = review(null, "good", NOW).schedule;
  assert.equal(isLearningSchedule(good), true);
  assert.ok(good.due - NOW > 2 * MINUTE_MS && good.due - NOW < 60 * MINUTE_MS, "first good moves to the next learning step");

  const graduated = review(good, "good", good.due).schedule;
  assert.equal(isLearningSchedule(graduated), false);
  assert.ok(graduated.scheduled_days >= 1);

  const easy = review(null, "easy", NOW).schedule;
  assert.equal(isLearningSchedule(easy), false);
  assert.ok(easy.scheduled_days >= 1);
});

test("a later review of a mature card pushes it further out; again lapses it", () => {
  let card = review(null, "easy", NOW).schedule;
  const first = card.scheduled_days;
  card = review(card, "good", card.due).schedule;
  assert.ok(card.scheduled_days > first);
  const lapsed = review(card, "again", card.due).schedule;
  assert.equal(lapsed.lapses, 1);
  assert.equal(isLearningSchedule(lapsed), true);
});

test("the log keeps what the statistics need", () => {
  const { log } = review(null, "good", NOW);
  assert.equal(log.wasNew, true);
  assert.equal(log.rating, "good");
  assert.equal(log.reviewedAt, NOW);
  assert.equal(log.dueBefore, null);
  assert.ok(Number.isFinite(log.stability) && Number.isFinite(log.difficulty));
  const second = review(review(null, "easy", NOW).schedule, "good", NOW + DAY_MS * 3);
  assert.equal(second.log.wasNew, false);
  assert.ok(Number.isFinite(second.log.dueBefore));
});

test("review does not mutate its input and rejects unknown grades", () => {
  const card = Object.freeze(review(null, "easy", NOW).schedule);
  review(card, "good", NOW + DAY_MS);
  assert.throws(() => review(null, "perfect", NOW), /grade/i);
});

test("new / due / learning predicates", () => {
  assert.equal(isNewSchedule(null), true);
  const card = review(null, "easy", NOW).schedule;
  assert.equal(isNewSchedule(card), false);
  assert.equal(isDueSchedule(card, NOW), false);
  assert.equal(isDueSchedule(card, card.due), true);
});

test("previewIntervals gives a label for each button", () => {
  const units = { min: "min", hour: "h", day: "j", month: "mois", year: "an" };
  const labels = previewIntervals(null, NOW, units);
  assert.deepEqual(Object.keys(labels), GRADES);
  assert.match(labels.again, /^\d+ min$/);
  assert.match(labels.easy, /j$/);
});

test("queue: learning cards first, then the oldest due, then every new card", () => {
  const cards = ["a", "b", "c", "d", "e"].map((key) => ({ key }));
  const learning = review(null, "again", NOW - 10 * MINUTE_MS).schedule; // due, learning
  const reviewOld = { ...review(null, "easy", NOW - 20 * DAY_MS).schedule };
  const reviewNew = { ...review(null, "easy", NOW - 15 * DAY_MS).schedule };
  reviewOld.due = NOW - 5 * DAY_MS;
  reviewNew.due = NOW - 1 * DAY_MS;
  const future = review(null, "easy", NOW).schedule;
  const schedules = { b: reviewNew, c: learning, d: reviewOld, e: future };
  const queue = buildReviewQueue({ cards, schedules, now: NOW });
  assert.deepEqual(queue.map((card) => card.key), ["c", "d", "b", "a"]);
});

test("migrateSchedule converts the previous SM-2 format and leaves FSRS data alone", () => {
  const fsrsCard = review(null, "easy", NOW).schedule;
  assert.deepEqual(migrateSchedule(fsrsCard), fsrsCard);
  const old = { ease: 2.5, interval: 7, reps: 3, lapses: 1, due: NOW + 7 * DAY_MS, last: NOW };
  const migrated = migrateSchedule(old);
  assert.equal(migrated.due, old.due);
  assert.equal(migrated.scheduled_days, 7);
  assert.equal(isNewSchedule(migrated), false);
  assert.equal(isLearningSchedule(migrated), false);
  assert.ok(migrated.stability >= 7);
  const next = review(migrated, "good", migrated.due).schedule;
  assert.ok(next.scheduled_days > 7);
});
