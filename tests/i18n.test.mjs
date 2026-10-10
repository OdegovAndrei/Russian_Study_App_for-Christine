import test from "node:test";
import assert from "node:assert/strict";
import { STRINGS, LANGUAGES, translate, normalizeLanguage } from "../web/i18n.js";

test("english and french define exactly the same keys", () => {
  assert.deepEqual(Object.keys(STRINGS.en).sort(), Object.keys(STRINGS.fr).sort());
  assert.deepEqual(LANGUAGES, ["fr", "en"]);
});

test("no translation is empty", () => {
  for (const lang of LANGUAGES) {
    for (const [key, value] of Object.entries(STRINGS[lang])) assert.ok(value.trim(), `${lang}.${key}`);
  }
});

test("translate interpolates and falls back to french then key", () => {
  assert.equal(translate("en", "count", { shown: 3, total: 9 }), "3 of 9");
  assert.equal(translate("fr", "count", { shown: 3, total: 9 }), "3 sur 9");
  assert.equal(translate("xx", "tab.review"), STRINGS.fr["tab.review"]);
  assert.equal(translate("en", "does.not.exist"), "does.not.exist");
});

test("normalizeLanguage defaults to french", () => {
  assert.equal(normalizeLanguage("en"), "en");
  assert.equal(normalizeLanguage("de"), "fr");
  assert.equal(normalizeLanguage(undefined), "fr");
});
