import test from "node:test";
import assert from "node:assert/strict";
import { cardKey, dayKey, expandCards } from "../web/deck.js";

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

import { parseBulk, mergeWords } from "../web/deck.js";

test("parseBulk reads one pair per line and detects the Russian side", () => {
  const { entries, invalid } = parseBulk("bonjour ; здравствуйте\nкнига | un livre\n\n  merci\t спасибо ");
  assert.deepEqual(entries, [
    { fr: "bonjour", ru: "здравствуйте" },
    { fr: "un livre", ru: "книга" },
    { fr: "merci", ru: "спасибо" }
  ]);
  assert.deepEqual(invalid, []);
});

test("parseBulk reports lines without two parts", () => {
  const { entries, invalid } = parseBulk("oui ; да\nseulement\n ; vide\na ; b ; c");
  assert.equal(entries.length, 2);
  assert.deepEqual(invalid, [2, 3]);
  assert.deepEqual(entries[1], { fr: "a", ru: "b ; c" });
});

test("mergeWords skips Russian duplicates, also inside the batch", () => {
  const existing = [{ id: "c1", ru: "да", fr: "oui", kind: "custom" }];
  const result = mergeWords(existing, [
    { fr: "oui", ru: "Да" },
    { fr: "non", ru: "нет" },
    { fr: "nein", ru: "НЕТ" }
  ], () => "n1");
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.words.map((w) => w.ru), ["да", "нет"]);
});

import { updateWord } from "../web/deck.js";

const WORDS = [
  { id: "a", ru: "привет", fr: "salut", kind: "word" },
  { id: "b", ru: "спасибо", fr: "merci", kind: "word" }
];

test("updateWord changes both sides and keeps the id (so progress is kept)", () => {
  const result = updateWord(WORDS, "a", { fr: " bonjour ", ru: "здравствуйте" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.words[0], { id: "a", ru: "здравствуйте", fr: "bonjour", kind: "word" });
  assert.equal(result.words[1], WORDS[1]);
  assert.equal(WORDS[0].fr, "salut");
});

test("updateWord refuses empty text, a duplicate Russian word and unknown ids", () => {
  assert.equal(updateWord(WORDS, "a", { fr: "", ru: "x" }).reason, "empty");
  assert.equal(updateWord(WORDS, "a", { fr: "salut", ru: "СПАСИБО" }).reason, "duplicate");
  assert.equal(updateWord(WORDS, "zzz", { fr: "a", ru: "b" }).reason, "missing");
});

test("updateWord allows keeping the same Russian word with a new translation", () => {
  const result = updateWord(WORDS, "a", { fr: "coucou", ru: "Привет" });
  assert.equal(result.ok, true);
  assert.equal(result.words[0].fr, "coucou");
});
