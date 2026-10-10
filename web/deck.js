// Pure helpers: turn vocabulary items into cards and pick today's queue.
export const DIRECTIONS = ["fr-ru", "ru-fr", "both"];

export function cardKey(itemId, direction) {
  return `${itemId}|${direction}`;
}

export function dayKey(now = Date.now()) {
  const date = new Date(now);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function makeCard(item, direction) {
  const frontIsFrench = direction === "fr-ru";
  return {
    key: cardKey(item.id, direction),
    itemId: item.id,
    direction,
    kind: item.kind,
    front: frontIsFrench ? item.fr : item.ru,
    back: frontIsFrench ? item.ru : item.fr,
    frontLang: frontIsFrench ? "fr" : "ru",
    ru: item.ru,
    fr: item.fr
  };
}

export function expandCards(items, direction) {
  const directions = direction === "both" ? ["fr-ru", "ru-fr"] : [direction];
  return items.flatMap((item) => directions.map((dir) => makeCard(item, dir)));
}

export function buildQueue({ items, direction, schedules, now }) {
  const due = [];
  const fresh = [];
  for (const card of expandCards(items, direction)) {
    const state = schedules[card.key];
    if (!state) fresh.push(card);
    else if (state.due <= now) due.push({ ...card, state });
  }
  due.sort((left, right) => left.state.due - right.state.due);
  return { due, new: fresh };
}

/** Adds the bundled starter words to a state that has never been seeded. */
export function applyStarter(state, starter) {
  if (state.seeded) return state;
  const known = new Set(state.custom.map((item) => item.ru.toLocaleLowerCase()));
  const fresh = starter.filter((item) => !known.has(item.ru.toLocaleLowerCase()));
  return { ...state, seeded: true, custom: [...fresh, ...state.custom] };
}

const CYRILLIC = /[Ѐ-ӿ]/;
const BULK_SEPARATORS = /\s*[;|\t]\s*/;

/**
 * One "french ; russian" pair per line (`;`, `|` or a tab). The Cyrillic part
 * is taken as the Russian side, so either order works.
 */
export function parseBulk(text) {
  const entries = [];
  const invalid = [];
  String(text).split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const match = trimmed.search(BULK_SEPARATORS);
    const parts = match < 0 ? [trimmed] : [trimmed.slice(0, match), trimmed.slice(match).replace(BULK_SEPARATORS, "")];
    const [first, second] = parts.map((part) => part.trim());
    if (!first || !second) {
      invalid.push(index + 1);
      return;
    }
    const swap = CYRILLIC.test(first) && !CYRILLIC.test(second);
    entries.push(swap ? { fr: second, ru: first } : { fr: first, ru: second });
  });
  return { entries, invalid };
}

/** Appends new words to the list, skipping Russian words that already exist. */
export function mergeWords(existing, entries, makeId) {
  const known = new Set(existing.map((item) => item.ru.toLocaleLowerCase()));
  const words = [...existing];
  let added = 0;
  let skipped = 0;
  for (const entry of entries) {
    const ru = entry.ru.trim();
    const fr = entry.fr.trim();
    const key = ru.toLocaleLowerCase();
    if (!ru || !fr || known.has(key)) {
      skipped += 1;
      continue;
    }
    known.add(key);
    words.push({ id: makeId(), ru, fr, kind: "custom" });
    added += 1;
  }
  return { words, added, skipped };
}
