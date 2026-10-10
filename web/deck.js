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
