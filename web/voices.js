// Choosing a browser (system) voice by gender. Used when the neural server
// voice is unavailable, so Svetlana/Dmitry still sound different.
const FEMALE = ["milena", "irina", "svetlana", "katya", "alena", "anna", "tatyana", "yelena", "female", "woman", "женск"];
const MALE = ["yuri", "pavel", "dmitry", "dmitri", "maxim", "mikhail", "male", "мужск"];

export function classifyVoice(name) {
  const lower = ` ${String(name).toLowerCase()} `;
  // "female" contains "male": test the female list first.
  if (FEMALE.some((hint) => lower.includes(hint))) return "female";
  if (MALE.some((hint) => lower.includes(hint))) return "male";
  return "unknown";
}

export function pickVoice(voices, wantMale) {
  const russian = voices.filter((voice) => /^ru\b|^ru[-_]/i.test(voice.lang));
  if (!russian.length) return { voice: null, matched: false };
  const wanted = wantMale ? "male" : "female";
  const exact = russian.find((voice) => classifyVoice(voice.name) === wanted);
  if (exact) return { voice: exact, matched: true };
  const neutral = russian.find((voice) => classifyVoice(voice.name) === "unknown");
  return { voice: neutral || russian[0], matched: false };
}

/** Resolves with the system voices once the browser has loaded them (they arrive asynchronously). */
export function loadVoices(synth = window.speechSynthesis, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!synth) return resolve([]);
    const ready = synth.getVoices();
    if (ready.length) return resolve(ready);
    const finish = () => {
      synth.removeEventListener?.("voiceschanged", finish);
      resolve(synth.getVoices());
    };
    synth.addEventListener?.("voiceschanged", finish);
    setTimeout(finish, timeoutMs);
  });
}
