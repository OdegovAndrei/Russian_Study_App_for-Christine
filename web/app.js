import { newCardState, review, previewIntervals, GRADES, DAY_MS } from "./srs.js";
import { buildQueue, cardKey, dayKey } from "./deck.js";
import { LANGUAGES, normalizeLanguage, translate } from "./i18n.js";

const VOICES = ["ru-RU-SvetlanaNeural", "ru-RU-DmitryNeural"];
const DIRECTIONS = ["fr-ru", "ru-fr", "both"];

const DEFAULT_SETTINGS = {
  direction: "fr-ru",
  voice: "ru-RU-SvetlanaNeural",
  rate: 0.9,
  newPerDay: 10,
  autoplay: true,
  uiLang: "fr"
};

const app = document.getElementById("app");
const saveIndicator = document.getElementById("save-indicator");

function t(key, vars) {
  return translate(normalizeLanguage(state.settings.uiLang), key, vars);
}

function applyStaticText() {
  document.documentElement.lang = normalizeLanguage(state.settings.uiLang);
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelector(".tabs").setAttribute("aria-label", t("nav.label"));
  document.querySelectorAll(".lang-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.lang === normalizeLanguage(state.settings.uiLang));
  });
}

function setLanguage(language) {
  state.settings.uiLang = normalizeLanguage(language);
  scheduleSave();
  render();
}

let vocabulary = [];
let state = defaultState();
let view = "review";
let session = null;
let vocabFilter = { text: "", kind: "all" };

function defaultState() {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, schedules: {}, introduced: {}, custom: [], log: {} };
}

function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== "object") return base;
  return {
    version: 1,
    settings: { ...base.settings, ...(raw.settings || {}) },
    schedules: raw.schedules && typeof raw.schedules === "object" ? raw.schedules : {},
    introduced: raw.introduced && typeof raw.introduced === "object" ? raw.introduced : {},
    custom: Array.isArray(raw.custom) ? raw.custom.filter((item) => item && item.id && item.ru && item.fr) : [],
    log: raw.log && typeof raw.log === "object" ? raw.log : {}
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
  const [vocabResponse, stateResponse] = await Promise.all([
    fetch("vocabulary.json"),
    fetch("/api/state").catch(() => null)
  ]);
  vocabulary = await vocabResponse.json();
  if (stateResponse && stateResponse.ok) {
    const payload = await stateResponse.json();
    state = normalizeState(payload.state);
  }
}

function allItems() {
  return [...vocabulary, ...state.custom];
}

// ---- speech --------------------------------------------------------------
let currentAudio = null;

function browserSpeak(text) {
  if (!("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ru-RU";
  utterance.rate = state.settings.rate;
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
  } catch {
    browserSpeak(text);
  }
}

// ---- review ---------------------------------------------------------------
function startSession() {
  const now = Date.now();
  const queue = buildQueue({
    items: allItems(),
    direction: state.settings.direction,
    schedules: state.schedules,
    now,
    newPerDay: state.settings.newPerDay,
    introducedToday: state.introduced[dayKey(now)] || 0
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
  if (session.newKeys.has(card.key)) {
    session.newKeys.delete(card.key);
    const today = dayKey(now);
    state.introduced[today] = (state.introduced[today] || 0) + 1;
  }
  const today = dayKey(now);
  const log = state.log[today] || { reviews: 0, again: 0 };
  log.reviews += 1;
  if (name === "again") log.again += 1;
  state.log[today] = log;

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
  if (!card) {
    const studiedToday = (state.log[dayKey()] || { reviews: 0 }).reviews;
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
  const label = h("div", { class: "card-label" }, `${isNew ? `${t("review.newCard")} · ` : ""}${t(card.kind === "phrase" ? "review.phrase" : "review.word")}`);
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
  return h("section", {}, counters, cardElement, controls, hint);
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
  const kind = vocabFilter.kind;
  if (kind === "word" && item.kind !== "word") return false;
  if (kind === "phrase" && item.kind !== "phrase") return false;
  if (kind === "custom" && item.kind !== "custom") return false;
  const needle = vocabFilter.text.trim().toLocaleLowerCase();
  if (!needle) return true;
  return item.ru.toLocaleLowerCase().includes(needle) || item.fr.toLocaleLowerCase().includes(needle);
}

function renderVocabulary() {
  const items = allItems();
  const search = h("input", {
    type: "search",
    placeholder: t("vocab.search"),
    "aria-label": t("vocab.searchLabel"),
    value: vocabFilter.text
  });
  const listHost = h("div", {});
  const refresh = () => {
    const shown = allItems().filter(matchesFilter);
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
            item.kind === "custom"
              ? h("button", { class: "btn danger", type: "button", onClick: () => removeCustom(item.id) }, t("vocab.delete"))
              : null
          )
        )
      )
    );
  };
  search.addEventListener("input", () => {
    vocabFilter.text = search.value;
    refresh();
  });

  const kinds = [["all", t("vocab.all")], ["word", t("vocab.words")], ["phrase", t("vocab.phrases")], ["custom", t("vocab.custom")]];
  const chips = h(
    "div",
    { class: "chips" },
    kinds.map(([kind, text]) =>
      h("button", {
        class: `chip${vocabFilter.kind === kind ? " active" : ""}`,
        type: "button",
        onClick: () => { vocabFilter.kind = kind; render(); }
      }, text)
    )
  );

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
  return h("section", {}, h("div", { class: "toolbar" }, search, chips), listHost, form, h("p", { class: "count-note" }, t("vocab.total", { total: items.length })));
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

  const direction = h(
    "select",
    { "aria-label": t("settings.direction"), onChange: (event) => update({ direction: event.target.value }) },
    DIRECTIONS.map((value) => h("option", { value, selected: settings.direction === value }, t(`direction.${value}`)))
  );
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
  const perDay = h("input", {
    type: "number", min: "0", max: "100", value: String(settings.newPerDay), "aria-label": t("settings.newPerDay"),
    onChange: (event) => update({ newPerDay: Math.max(0, Math.min(100, Math.round(Number(event.target.value) || 0))) })
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
      row(t("settings.direction"), t("settings.directionNote"), direction),
      row(t("settings.newPerDay"), null, perDay),
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
  state.introduced = {};
  state.log = {};
  session = null;
  scheduleSave();
  render();
}

// ---- shell -----------------------------------------------------------------
function render() {
  applyStaticText();
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  const content = view === "vocabulary" ? renderVocabulary() : view === "settings" ? renderSettings() : renderReview();
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
