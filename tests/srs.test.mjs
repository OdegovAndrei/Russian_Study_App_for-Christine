import test from "node:test";
import assert from "node:assert/strict";
import { newCardState, review, previewIntervals, DAY_MS, MINUTE_MS } from "../web/srs.js";

const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);

test("again on a new card schedules a short relearn step", () => {
  const next = review(newCardState(), "again", NOW);
  assert.equal(next.due, NOW + 10 * MINUTE_MS);
  assert.equal(next.reps, 0);
  assert.equal(next.lapses, 1);
});

test("good progresses 1 day, 3 days, then multiplies by ease", () => {
  let state = review(newCardState(), "good", NOW);
  assert.equal(state.interval, 1);
  assert.equal(state.due, NOW + DAY_MS);
  state = review(state, "good", NOW);
  assert.equal(state.interval, 3);
  state = review(state, "good", NOW);
  assert.equal(state.interval, Math.round(3 * state.ease));
  assert.ok(state.interval >= 7);
});

test("easy jumps further than good and raises ease", () => {
  const good = review(newCardState(), "good", NOW);
  const easy = review(newCardState(), "easy", NOW);
  assert.ok(easy.interval > good.interval);
  assert.ok(easy.ease > newCardState().ease);
});

test("hard never drops below one day and lowers ease", () => {
  const hard = review(newCardState(), "hard", NOW);
  assert.equal(hard.interval, 1);
  assert.ok(hard.ease < newCardState().ease);
});

test("again after a mature card resets progress but keeps ease above the floor", () => {
  let state = newCardState();
  for (let i = 0; i < 6; i += 1) state = review(state, "again", NOW);
  assert.ok(state.ease >= 1.3);
  const mature = { ...newCardState(), reps: 5, interval: 30 };
  const lapsed = review(mature, "again", NOW);
  assert.equal(lapsed.reps, 0);
  assert.equal(lapsed.interval, 0);
  assert.equal(lapsed.lapses, 1);
});

test("review does not mutate its input and rejects unknown grades", () => {
  const original = newCardState();
  const frozen = Object.freeze({ ...original });
  review(frozen, "good", NOW);
  assert.deepEqual(frozen, original);
  assert.throws(() => review(original, "perfect", NOW), /grade/i);
});

test("previewIntervals labels each button", () => {
  const labels = previewIntervals(newCardState(), NOW);
  assert.deepEqual(Object.keys(labels), ["again", "hard", "good", "easy"]);
  assert.equal(labels.again, "10 min");
  assert.equal(labels.good, "1 j");
});
