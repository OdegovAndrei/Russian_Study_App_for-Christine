import test from "node:test";
import assert from "node:assert/strict";
import { classifyVoice, pickVoice } from "../web/voices.js";

const v = (name, lang = "ru-RU") => ({ name, lang });

test("voice names are classified by gender", () => {
  assert.equal(classifyVoice("Milena"), "female");
  assert.equal(classifyVoice("Microsoft Irina - Russian (Russia)"), "female");
  assert.equal(classifyVoice("Microsoft Svetlana Online (Natural) - Russian"), "female");
  assert.equal(classifyVoice("Yuri"), "male");
  assert.equal(classifyVoice("Microsoft Pavel - Russian (Russia)"), "male");
  assert.equal(classifyVoice("Microsoft Dmitry Online (Natural) - Russian"), "male");
  assert.equal(classifyVoice("Google русский"), "unknown");
});

test("'female' is never mistaken for 'male'", () => {
  assert.equal(classifyVoice("Russian Female Voice"), "female");
  assert.equal(classifyVoice("Russian Male Voice"), "male");
});

test("pickVoice prefers the requested gender among Russian voices only", () => {
  const voices = [v("Samantha", "en-US"), v("Milena"), v("Yuri")];
  assert.deepEqual(pickVoice(voices, true), { voice: voices[2], matched: true });
  assert.deepEqual(pickVoice(voices, false), { voice: voices[1], matched: true });
});

test("when the gender is missing it returns a neutral voice, never the opposite gender", () => {
  const onlyFemale = [v("Milena"), v("Google русский")];
  const picked = pickVoice(onlyFemale, true);
  assert.equal(picked.matched, false);
  assert.equal(picked.voice.name, "Google русский");
  const strictlyFemale = pickVoice([v("Milena")], true);
  assert.equal(strictlyFemale.matched, false);
  assert.equal(strictlyFemale.voice.name, "Milena");
});

test("no Russian voices at all", () => {
  assert.deepEqual(pickVoice([v("Samantha", "en-US")], true), { voice: null, matched: false });
});
