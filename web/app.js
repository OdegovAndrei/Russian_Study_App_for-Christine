import { newCardState, review, previewIntervals, GRADES, DAY_MS } from "./srs.js";
import { applyStarter, buildQueue, cardKey, dayKey, expandCards } from "./deck.js";
import { buildTimingStats, buildDueBuckets, buildTimingChanges, formatTiming } from "./timing.js";
import { configureAnalytics, openReviewAnalyticsModal } from "./review-analytics.js";
import { LANGUAGES, normalizeLanguage, translate } from "./i18n.js";

const VOICES = ["ru-RU-SvetlanaNeural", "ru-RU-DmitryNeural"];
const DIRECTIONS = ["fr-ru", "ru-fr", "both"];

const DEFAULT_SETTINGS = {
  direction: "fr-ru",
  voice: "ru-RU-SvetlanaNeural",
  rate: 0.9,
  autoplay: true,
  uiLang: "fr"
};

const app = document.getElementById("app");
const saveIndicator = document.getElementById("save-indicator");
const modalRoot = document.getElementById("modal-root");
const DAY_LENGTH_MS = 24 * 60 * 60 * 1000;

function t(key, vars) {
  return translate(normalizeLanguage(state.settings.uiLang), key, vars);
}

function applyStaticText() {
  document.documentElement.lang = normalizeLanguage(state.settings.uiLang);
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelector(".tabs").setAttribute("aria-label", t("nav.label"));
  configureAnalytics({
    translate: t,
    locale: normalizeLanguage(state.settings.uiLang) === "en" ? "en-US" : "fr-FR"
  });
  document.querySelectorAll(".lang-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.lang === normalizeLanguage(state.settings.uiLang));
  });
}

function setLanguage(language) {
  state.settings.uiLang = normalizeLanguage(language);
  scheduleSave();
  render();
}

let state = defaultState();
let view = "review";
let session = null;
let vocabFilter = { text: "" };

function defaultState() {
  return { version: 2, seeded: false, settings: { ...DEFAULT_SETTINGS }, schedules: {}, custom: [], logs: [] };
}

function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== "object") return base;
  return {
    version: 2,
    seeded: raw.seeded === true,
    settings: { ...base.settings, ...(raw.settings || {}) },
    schedules: raw.schedules && typeof raw.schedules === "object" ? raw.schedules : {},
    custom: Array.isArray(raw.custom) ? raw.custom.filter((item) => item && item.id && item.ru && item.fr) : [],
    logs: Array.isArray(raw.logs) ? raw.logs.filter((log) => log && log.cardId && Number.isFinite(log.reviewedAt)) : []
  };
}

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === "class") element.className = value;
    else if (name.startsWith("on")) element.addEventListener(name.slice(2).toLowerCase(), value);
    else if (value === true) element.setAttribute(name, "");
    else if (value !== false && value != null) element.setAttribute(name, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

// ---- persistence -------------------------------------------------------
let saveTimer = null;
let saveChain = Promise.resolve();

function setSaveStatus(text) {
  saveIndicator.textContent = text;
}

function scheduleSave() {
  setSaveStatus(t("save.saving"));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const body = JSON.stringify(state);
    saveChain = saveChain
      .then(() => fetch("/api/state", { method: "PUT", headers: { "Content-Type": "application/json" }, body }))
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        setSaveStatus(t("save.saved"));
      })
      .catch(() => setSaveStatus(t("save.error")));
  }, 300);
}

async function loadAll() {
  const response = await fetch("/api/state").catch(() => null);
  if (response && response.ok) {
    const payload = await response.json();
    state = normalizeState(payload.state);
  }
  if (!state.seeded) {
    const starter = await fetch("starter.json").then((reply) => (reply.ok ? reply.json() : [])).catch(() => []);
    state = applyStarter(state, starter);
    scheduleSave();
  }
}

function allItems() {
  return state.custom;
}

// ---- speech --------------------------------------------------------------
let currentAudio = null;

const MALE_HINTS = ["yuri", "pavel", "dmitry", "dmitri", "maxim", "mikhail", "male", "man"];
const FEMALE_HINTS = ["milena", "irina", "svetlana", "katya", "alena", "anna", "female", "woman"];
let fallbackVoiceUsed = false;

function pickBrowserVoice(wantMale) {
  const voices = window.speechSynthesis.getVoices().filter((voice) => /^ru/i.test(voice.lang));
  const hints = wantMale ? MALE_HINTS : FEMALE_HINTS;
  const named = voices.find((voice) => hints.some((hint) => voice.name.toLowerCase().includes(hint)));
  return { voice: named || voices[0] || null, matched: Boolean(named) };
}

function browserSpeak(text) {
  if (!("speechSynthesis" in window)) return;
  const wantMale = state.settings.voice === "ru-RU-DmitryNeural";
  const { voice, matched } = pickBrowserVoice(wantMale);
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ru-RU";
  if (voice) utterance.voice = voice;
  utterance.rate = state.settings.rate;
  // No voice of the requested gender installed: lower the pitch so the choice is still audible.
  if (wantMale && !matched) utterance.pitch = 0.6;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

async function speak(text) {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  const { voice, rate } = state.settings;
  const url = `/tts?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice)}&rate=${rate}`;
  try {
    const audio = new Audio(url);
    currentAudio = audio;
    await audio.play();
    setFallbackNote(false);
  } catch {
    setFallbackNote(true);
    browserSpeak(text);
  }
}

function setFallbackNote(used) {
  if (fallbackVoiceUsed === used) return;
  fallbackVoiceUsed = used;
  const note = document.getElementById("voice-note");
  if (note) note.hidden = !used;
}

// ---- review ---------------------------------------------------------------
function startSession() {
  const now = Date.now();
  const queue = buildQueue({
    items: allItems(),
    direction: state.settings.direction,
    schedules: state.schedules,
    now
  });
  session = {
    queue: [...queue.due, ...queue.new],
    newKeys: new Set(queue.new.map((card) => card.key)),
    revealed: false,
    done: 0
  };
}

function currentCard() {
  return session && session.queue[0];
}

function reveal() {
  if (!session || session.revealed || !currentCard()) return;
  session.revealed = true;
  const card = currentCard();
  render();
  if (state.settings.autoplay && card.frontLang === "fr") speak(card.ru);
}

function grade(name) {
  const card = currentCard();
  if (!card || !session.revealed) return;
  const now = Date.now();
  const previous = state.schedules[card.key] || newCardState();
  const next = review(previous, name, now);
  state.schedules[card.key] = next;
  const wasNew = session.newKeys.has(card.key);
  session.newKeys.delete(card.key);
  state.logs.push({
    cardId: card.key,
    rating: name,
    reviewedAt: now,
    dueBefore: wasNew ? null : previous.due,
    dueAfter: next.due,
    wasNew
  });

  session.queue.shift();
  if (name === "again") session.queue.push({ ...card, state: next });
  else session.done += 1;
  session.revealed = false;
  scheduleSave();
  render();
  const following = currentCard();
  if (following && state.settings.autoplay && following.frontLang === "ru") speak(following.ru);
}

function renderReview() {
  if (!session) startSession();
  const card = currentCard();
  if (!card && !allItems().length) {
    return h(
      "section",
      { class: "empty" },
      h("h2", {}, t("review.noWordsTitle")),
      h("p", {}, t("review.noWordsBody")),
      h("button", { class: "btn primary", type: "button", onClick: () => { view = "vocabulary"; render(); } }, t("review.goVocabulary"))
    );
  }
  if (!card) {
    const studiedToday = reviewsToday();
    return h(
      "section",
      { class: "empty" },
      h("h2", {}, t(studiedToday ? "review.doneTitle" : "review.nothingTitle")),
      h("p", {}, studiedToday ? t("review.doneBody", { count: studiedToday }) : t("review.nothingBody")),
      h("button", { class: "btn", type: "button", onClick: () => { startSession(); render(); } }, t("review.checkAgain"))
    );
  }

  const remaining = session.queue.length;
  const newLeft = session.queue.filter((item) => session.newKeys.has(item.key)).length;
  const counters = h(
    "div",
    { class: "counters" },
    h("span", {}, t("review.remaining") + " ", h("strong", {}, remaining)),
    h("span", {}, t("review.new") + " ", h("strong", {}, newLeft)),
    h("span", {}, t("review.done") + " ", h("strong", {}, session.done))
  );

  const isNew = session.newKeys.has(card.key);
  const label = h("div", { class: "card-label" }, isNew ? t("review.newCard") : t("review.reviewCard"));
  const front = h("div", { class: "card-front", lang: card.frontLang }, card.front);
  const children = [label, front];
  if (card.frontLang === "ru") {
    children.push(h("div", { class: "card-actions" }, speakButton(card.ru)));
  }
  if (session.revealed) {
    children.push(h("hr", { class: "card-divider" }));
    children.push(h("div", { class: "card-back", lang: card.frontLang === "fr" ? "ru" : "fr" }, card.back));
    if (card.frontLang === "fr") children.push(h("div", { class: "card-actions" }, speakButton(card.ru)));
  }
  const cardElement = h("article", { class: "card" }, children);

  let controls;
  if (!session.revealed) {
    controls = h(
      "div",
      { class: "answer-row" },
      h("button", { class: "btn primary", type: "button", onClick: reveal }, t("review.show"))
    );
  } else {
    const preview = previewIntervals(card.state || state.schedules[card.key] || newCardState());
    controls = h(
      "div",
      { class: "grades" },
      GRADES.map((name, index) =>
        h(
          "button",
          { class: "grade", type: "button", "data-grade": name, onClick: () => grade(name) },
          h("span", {}, t(`grade.${name}`)),
          h("small", {}, `${preview[name]} · ${index + 1}`)
        )
      )
    );
  }
  const hint = h("p", { class: "hint" }, t("review.hint"));
  const voiceNote = h("p", { class: "hint", id: "voice-note", hidden: !fallbackVoiceUsed }, t("review.fallbackVoice"));
  return h("section", {}, directionBar(), timingBar(), counters, cardElement, controls, hint, voiceNote);
}

// ---- direction, plan timing, statistics -------------------------------------
function analyticsCards() {
  return expandCards(allItems(), state.settings.direction).map((card) => ({ id: card.key, noteId: card.itemId }));
}

function reviewsToday(now = Date.now()) {
  const start = new Date(now).setHours(0, 0, 0, 0);
  return state.logs.filter((log) => log.reviewedAt >= start).length;
}

function streakDays(now = Date.now()) {
  const days = new Set(state.logs.map((log) => dayKey(log.reviewedAt)));
  let cursor = new Date(now);
  if (!days.has(dayKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  let count = 0;
  while (days.has(dayKey(cursor.getTime()))) {
    count += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

function setDirection(direction) {
  if (state.settings.direction === direction) return;
  state.settings.direction = direction;
  session = null;
  scheduleSave();
  render();
}

function directionBar() {
  return h(
    "div",
    { class: "direction-bar", role: "group", "aria-label": t("review.direction") },
    DIRECTIONS.map((value) =>
      h("button", {
        class: `chip${state.settings.direction === value ? " active" : ""}`,
        type: "button",
        "aria-pressed": String(state.settings.direction === value),
        onClick: () => setDirection(value)
      }, t(`direction.${value}`))
    )
  );
}

function bucketItems(buckets) {
  return [
    ["today", t("an.today"), buckets.today],
    ["tomorrow", t("an.tomorrow"), buckets.tomorrow],
    ["days2to15", t("an.days2to15"), buckets.days2to15],
    ["later", t("an.later"), buckets.later]
  ];
}

function changeBadge(letter, deltaMs, title) {
  const days = deltaMs / DAY_LENGTH_MS;
  const stable = Math.abs(days) < 0.005;
  const kind = stable ? "neutral" : days > 0 ? "positive" : "negative";
  const value = stable ? "0.00" : `${days > 0 ? "+" : "−"}${Math.abs(days).toFixed(2)}`;
  return h("span", { class: `review-timing-change ${kind}`, title }, `${letter}: ${value}`);
}

function openAnalytics(opener) {
  openReviewAnalyticsModal({
    modalRoot,
    cards: analyticsCards(),
    schedules: state.schedules,
    logs: state.logs,
    opener
  });
}

function timingBar() {
  const cards = analyticsCards();
  const now = new Date();
  const buckets = buildDueBuckets({ cards, schedules: state.schedules, now });
  if (!buckets.total) return null;
  const stats = buildTimingStats({ cards, schedules: state.schedules, now });
  const changes = buildTimingChanges({ cards, schedules: state.schedules, logs: state.logs, now });
  const items = bucketItems(buckets);
  const average = formatTiming(stats, t);
  return h(
    "div",
    { class: "review-title-timing" },
    h(
      "button",
      { class: "review-title-timing-trigger", type: "button", "aria-haspopup": "dialog", "aria-label": t("timing.open"), onClick: (event) => openAnalytics(event.currentTarget) },
      h("span", { class: "review-title-timing-label" }, t("timing.label")),
      h(
        "span",
        { class: "review-title-timing-average" },
        t("timing.average", { value: average }),
        h("span", { class: "review-timing-changes" }, changeBadge("d", changes.dayDeltaMs, t("timing.dayChange")), changeBadge("w", changes.weekDeltaMs, t("timing.weekChange")))
      ),
      h("span", { class: "review-title-buckets", role: "list" },
        items.map(([kind, label, count]) => h("span", { class: `review-title-bucket ${kind}`, role: "listitem" }, h("strong", {}, count), h("span", {}, label)))),
      h("span", { class: "review-title-timing-track", role: "img", "aria-label": items.map(([, label, count]) => `${label}: ${count}`).join(", ") },
        items.map(([kind, label, count]) => h("span", { class: `review-title-timing-segment ${kind}`, style: `flex-grow: ${count}`, title: `${label}: ${count}` })))
    )
  );
}

function metric(label, value, note) {
  return h("div", { class: "metric" }, h("p", { class: "eyebrow" }, label), h("strong", {}, value), h("span", {}, note));
}

function renderStats() {
  const cards = analyticsCards();
  const now = Date.now();
  const cardIds = new Set(cards.map((card) => card.id));
  const logs = state.logs.filter((log) => cardIds.has(log.cardId));
  const studied = new Set(logs.map((log) => log.cardId)).size;
  const dueCount = cards.filter((card) => state.schedules[card.id] && state.schedules[card.id].due <= now).length;
  const masteredCount = cards.filter((card) => (state.schedules[card.id]?.interval || 0) >= 21).length;
  const correct = logs.filter((log) => log.rating !== "again").length;
  const accuracy = logs.length ? `${Math.round((correct / logs.length) * 100)}%` : "—";
  const today = reviewsToday(now);
  const names = new Map(allItems().flatMap((item) => [[`${item.id}|fr-ru`, item], [`${item.id}|ru-fr`, item]]));
  const latest = [...state.logs].sort((a, b) => b.reviewedAt - a.reviewedAt).slice(0, 12);
  const locale = normalizeLanguage(state.settings.uiLang) === "en" ? "en-US" : "fr-FR";
  const formatter = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return h(
    "section",
    {},
    h(
      "div",
      { class: "metrics-grid" },
      metric(t("stats.cards"), cards.length, t("stats.cardsNote", { n: studied })),
      metric(t("stats.due"), dueCount, t("stats.dueNote")),
      metric(t("stats.mastered"), masteredCount, t("stats.masteredNote")),
      metric(t("stats.reviews"), state.logs.length, t("stats.reviewsNote", { n: today })),
      metric(t("stats.accuracy"), accuracy, t("stats.accuracyNote")),
      metric(t("stats.streak"), streakDays(now), t("stats.streakNote"))
    ),
    h("p", {}, h("button", { class: "btn primary", type: "button", onClick: (event) => openAnalytics(event.currentTarget) }, t("stats.openAnalytics"))),
    h("h3", {}, t("stats.history")),
    latest.length
      ? h(
          "div",
          { class: "history-list" },
          latest.map((log) => {
            const item = names.get(log.cardId);
            return h(
              "div",
              { class: "history-row" },
              h("strong", {}, item ? `${item.ru} — ${item.fr}` : t("stats.deletedCard")),
              h("span", {}, t(`grade.${log.rating}`)),
              h("time", {}, formatter.format(new Date(log.reviewedAt)))
            );
          })
        )
      : h("div", { class: "empty-state" }, t("stats.historyEmpty"))
  );
}

function speakButton(text) {
  return h(
    "button",
    { class: "icon-btn", type: "button", title: t("listen.key"), "aria-label": t("listen"), onClick: () => speak(text) },
    "🔊"
  );
}

// ---- vocabulary -----------------------------------------------------------
function statusOf(item) {
  const directions = state.settings.direction === "both" ? ["fr-ru", "ru-fr"] : [state.settings.direction];
  const states = directions.map((dir) => state.schedules[cardKey(item.id, dir)]).filter(Boolean);
  if (!states.length) return t("status.new");
  const state0 = states[0];
  if (state0.interval >= 21) return t("status.mastered");
  if (state0.due <= Date.now()) return t("status.due");
  const days = Math.max(1, Math.round((state0.due - Date.now()) / DAY_MS));
  return state0.interval === 0 ? t("status.learning") : t("status.inDays", { days });
}

function matchesFilter(item) {
  const needle = vocabFilter.text.trim().toLocaleLowerCase();
  if (!needle) return true;
  return item.ru.toLocaleLowerCase().includes(needle) || item.fr.toLocaleLowerCase().includes(needle);
}

function renderVocabulary() {
  const search = h("input", {
    type: "search",
    placeholder: t("vocab.search"),
    "aria-label": t("vocab.searchLabel"),
    value: vocabFilter.text
  });
  const listHost = h("div", {});
  const refresh = () => {
    const shown = allItems().filter(matchesFilter);
    if (!allItems().length) {
      listHost.replaceChildren(h("div", { class: "empty-state" }, t("vocab.empty")));
      return;
    }
    listHost.replaceChildren(
      h("p", { class: "count-note" }, t("count", { shown: shown.length, total: allItems().length })),
      h(
        "ul",
        { class: "word-list" },
        shown.map((item) =>
          h(
            "li",
            { class: "word" },
            speakButton(item.ru),
            h(
              "div",
              { class: "word-text" },
              h("div", { class: "word-ru", lang: "ru" }, item.ru),
              h("div", { class: "word-fr", lang: "fr" }, item.fr)
            ),
            h("span", { class: "badge" }, statusOf(item)),
            h("button", { class: "btn danger", type: "button", onClick: () => removeCustom(item.id) }, t("vocab.delete"))
          )
        )
      )
    );
  };
  search.addEventListener("input", () => {
    vocabFilter.text = search.value;
    refresh();
  });

  const frInput = h("input", { type: "text", placeholder: t("vocab.frPlaceholder"), "aria-label": t("vocab.frLabel"), required: true });
  const ruInput = h("input", { type: "text", placeholder: t("vocab.ruPlaceholder"), "aria-label": t("vocab.ruLabel"), lang: "ru", required: true });
  const form = h(
    "form",
    { class: "add-form", onSubmit: (event) => {
      event.preventDefault();
      addCustom(frInput.value, ruInput.value);
    } },
    frInput,
    ruInput,
    h("button", { class: "btn primary", type: "submit" }, t("vocab.add"))
  );

  refresh();
  return h("section", {}, form, h("div", { class: "toolbar" }, search), listHost);
}

function addCustom(fr, ru) {
  const cleanFr = fr.trim();
  const cleanRu = ru.trim();
  if (!cleanFr || !cleanRu) return;
  const exists = allItems().some((item) => item.ru.toLocaleLowerCase() === cleanRu.toLocaleLowerCase());
  if (exists) {
    window.alert(t("vocab.duplicate"));
    return;
  }
  state.custom.push({ id: `c${Date.now().toString(36)}`, ru: cleanRu, fr: cleanFr, kind: "custom" });
  session = null;
  scheduleSave();
  render();
}

function removeCustom(id) {
  state.custom = state.custom.filter((item) => item.id !== id);
  for (const key of Object.keys(state.schedules)) {
    if (key.startsWith(`${id}|`)) delete state.schedules[key];
  }
  session = null;
  scheduleSave();
  render();
}

// ---- settings --------------------------------------------------------------
function renderSettings() {
  const settings = state.settings;
  const update = (patch) => {
    Object.assign(state.settings, patch);
    session = null;
    scheduleSave();
  };

  const language = h(
    "select",
    { "aria-label": t("settings.language"), onChange: (event) => setLanguage(event.target.value) },
    LANGUAGES.map((value) => h("option", { value, selected: normalizeLanguage(settings.uiLang) === value }, t(`lang.${value}`)))
  );
  const voice = h(
    "select",
    { "aria-label": t("settings.voice"), onChange: (event) => update({ voice: event.target.value }) },
    VOICES.map((value) => h("option", { value, selected: settings.voice === value }, t(`voice.${value}`)))
  );
  const rateLabel = h("span", {}, `${settings.rate.toFixed(2)}×`);
  const rate = h("input", {
    type: "range", min: "0.6", max: "1.2", step: "0.05", value: String(settings.rate), "aria-label": t("settings.rate"),
    onInput: (event) => {
      const value = Number(event.target.value);
      rateLabel.textContent = `${value.toFixed(2)}×`;
      update({ rate: value });
    }
  });
  const autoplay = h("input", {
    type: "checkbox", checked: settings.autoplay, "aria-label": t("settings.autoplay"),
    onChange: (event) => update({ autoplay: event.target.checked })
  });

  const row = (title, note, control) =>
    h("div", { class: "setting" }, h("div", {}, h("strong", {}, title), note ? h("small", {}, note) : null), control);

  return h(
    "section",
    {},
    h(
      "div",
      { class: "settings" },
      row(t("settings.language"), t("settings.languageNote"), language),
      row(t("settings.autoplay"), t("settings.autoplayNote"), autoplay),
      row(t("settings.voice"), null, voice),
      row(t("settings.rate"), null, h("div", {}, rate, " ", rateLabel))
    ),
    h("p", {}, h("button", { class: "btn danger", type: "button", onClick: resetProgress }, t("settings.reset")))
  );
}

function resetProgress() {
  if (!window.confirm(t("settings.resetConfirm"))) return;
  state.schedules = {};
  state.logs = [];
  session = null;
  scheduleSave();
  render();
}

// ---- shell -----------------------------------------------------------------
function render() {
  applyStaticText();
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  const content = view === "vocabulary" ? renderVocabulary() : view === "settings" ? renderSettings() : view === "stats" ? renderStats() : renderReview();
  app.replaceChildren(content);
}

document.querySelectorAll(".lang-btn").forEach((button) => {
  button.addEventListener("click", () => setLanguage(button.dataset.lang));
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    view = tab.dataset.view;
    if (view === "review") session = null;
    render();
  });
});

document.addEventListener("keydown", (event) => {
  if (view !== "review" || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
  const card = currentCard();
  if (!card) return;
  if (event.key === " " || event.key === "Enter") {
    if (target instanceof HTMLElement && target.tagName === "BUTTON") return;
    event.preventDefault();
    if (!session.revealed) reveal();
  } else if (["1", "2", "3", "4"].includes(event.key)) {
    grade(GRADES[Number(event.key) - 1]);
  } else if (event.key.toLowerCase() === "r") {
    speak(card.ru);
  }
});

loadAll()
  .then(() => {
    setSaveStatus("");
    render();
  })
  .catch(() => {
    app.replaceChildren(h("p", { class: "empty" }, t("load.error")));
  });
