import test from "node:test";
import assert from "node:assert/strict";
import { cardKey, buildQueue, dayKey, expandCards } from "../web/deck.js";
import { newCardState, review } from "../web/srs.js";

const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);
const ITEMS = [
  { id: "a", ru: "привет", fr: "salut", kind: "word" },
  { id: "b", ru: "спасибо", fr: "merci", kind: "word" },
  { id: "c", ru: "пока", fr: "au revoir", kind: "word" }
];

test("expandCards builds one card per direction", () => {
  assert.deepEqual(expandCards(ITEMS, "fr-ru").map((c) => c.key), ["a|fr-ru", "b|fr-ru", "c|fr-ru"]);
  assert.equal(expandCards(ITEMS, "both").length, 6);
  const card = expandCards(ITEMS, "ru-fr")[0];
  assert.equal(card.front, "привет");
  assert.equal(card.back, "salut");
  assert.equal(card.frontLang, "ru");
});

test("every new card is queued: there is no daily limit", () => {
  const queue = buildQueue({ items: ITEMS, direction: "fr-ru", schedules: {}, now: NOW });
  assert.deepEqual(queue.new.map((c) => c.key), ["a|fr-ru", "b|fr-ru", "c|fr-ru"]);
  assert.equal(queue.due.length, 0);
});

test("due cards are listed oldest first and future cards are skipped", () => {
  const schedules = {
    "a|fr-ru": { ...newCardState(), due: NOW - 1000, reps: 1, interval: 1 },
    "b|fr-ru": { ...newCardState(), due: NOW - 5000, reps: 1, interval: 1 },
    "c|fr-ru": review(newCardState(), "good", NOW)
  };
  const queue = buildQueue({ items: ITEMS, direction: "fr-ru", schedules, now: NOW });
  assert.deepEqual(queue.due.map((c) => c.key), ["b|fr-ru", "a|fr-ru"]);
  assert.equal(queue.new.length, 0);
});

test("schedules are kept per direction", () => {
  const schedules = { "a|fr-ru": { ...newCardState(), due: NOW + 99999, reps: 1, interval: 1 } };
  const queue = buildQueue({ items: ITEMS, direction: "ru-fr", schedules, now: NOW });
  assert.equal(queue.new.length, 3);
});

test("cardKey and dayKey", () => {
  assert.equal(cardKey("a", "fr-ru"), "a|fr-ru");
  assert.match(dayKey(NOW), /^\d{4}-\d{2}-\d{2}$/);
});

import { applyStarter } from "../web/deck.js";

test("starter words are seeded once and stay deletable", () => {
  const starter = [{ id: "s1", ru: "да", fr: "oui", kind: "word" }];
  const mine = { id: "c1", ru: "книга", fr: "un livre", kind: "custom" };
  const seeded = applyStarter({ seeded: false, custom: [mine] }, starter);
  assert.deepEqual(seeded.custom.map((i) => i.id), ["s1", "c1"]);
  assert.equal(seeded.seeded, true);
  const cleared = applyStarter({ ...seeded, custom: [] }, starter);
  assert.equal(cleared.custom.length, 0);
});

test("starter does not duplicate a Russian word the user already has", () => {
  const starter = [{ id: "s1", ru: "Да", fr: "oui", kind: "word" }];
  const seeded = applyStarter({ seeded: false, custom: [{ id: "c1", ru: "да", fr: "oui", kind: "custom" }] }, starter);
  assert.equal(seeded.custom.length, 1);
});
