import { newCardState, review, previewIntervals, GRADES, DAY_MS } from "./srs.js";
import { buildQueue, cardKey, dayKey } from "./deck.js";

const GRADE_LABELS = { again: "À revoir", hard: "Difficile", good: "Bien", easy: "Facile" };
const DIRECTION_LABELS = {
  "fr-ru": "Français → russe",
  "ru-fr": "Russe → français",
  both: "Les deux sens"
};
const VOICE_LABELS = {
  "ru-RU-SvetlanaNeural": "Svetlana (voix féminine)",
  "ru-RU-DmitryNeural": "Dmitry (voix masculine)"
};

const DEFAULT_SETTINGS = {
  direction: "fr-ru",
  voice: "ru-RU-SvetlanaNeural",
  rate: 0.9,
  newPerDay: 10,
  autoplay: true
};

const app = document.getElementById("app");
const saveIndicator = document.getElementById("save-indicator");

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
  setSaveStatus("Enregistrement…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const body = JSON.stringify(state);
    saveChain = saveChain
      .then(() => fetch("/api/state", { method: "PUT", headers: { "Content-Type": "application/json" }, body }))
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        setSaveStatus("Enregistré");
      })
      .catch(() => setSaveStatus("Erreur d’enregistrement"));
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
      h("h2", {}, studiedToday ? "Bravo, c’est terminé pour aujourd’hui !" : "Rien à réviser pour le moment"),
      h("p", {}, studiedToday ? `${studiedToday} cartes révisées aujourd’hui.` : "Revenez plus tard ou augmentez le nombre de nouvelles cartes dans les réglages."),
      h("button", { class: "btn", type: "button", onClick: () => { startSession(); render(); } }, "Vérifier à nouveau")
    );
  }

  const remaining = session.queue.length;
  const newLeft = session.queue.filter((item) => session.newKeys.has(item.key)).length;
  const counters = h(
    "div",
    { class: "counters" },
    h("span", {}, "Restantes : ", h("strong", {}, remaining)),
    h("span", {}, "Nouvelles : ", h("strong", {}, newLeft)),
    h("span", {}, "Faites : ", h("strong", {}, session.done))
  );

  const isNew = session.newKeys.has(card.key);
  const label = h("div", { class: "card-label" }, `${isNew ? "Nouvelle carte · " : ""}${card.kind === "phrase" ? "Phrase" : "Mot"}`);
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
      h("button", { class: "btn primary", type: "button", onClick: reveal }, "Afficher la réponse")
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
          h("span", {}, GRADE_LABELS[name]),
          h("small", {}, `${preview[name]} · ${index + 1}`)
        )
      )
    );
  }
  const hint = h("p", { class: "hint" }, "Espace : afficher · 1–4 : noter · R : réécouter");
  return h("section", {}, counters, cardElement, controls, hint);
}

function speakButton(text) {
  return h(
    "button",
    { class: "icon-btn", type: "button", title: "Écouter (R)", "aria-label": "Écouter", onClick: () => speak(text) },
    "🔊"
  );
}

// ---- vocabulary -----------------------------------------------------------
function statusOf(item) {
  const directions = state.settings.direction === "both" ? ["fr-ru", "ru-fr"] : [state.settings.direction];
  const states = directions.map((dir) => state.schedules[cardKey(item.id, dir)]).filter(Boolean);
  if (!states.length) return "Nouveau";
  const state0 = states[0];
  if (state0.interval >= 21) return "Acquis";
  if (state0.due <= Date.now()) return "À réviser";
  const days = Math.max(1, Math.round((state0.due - Date.now()) / DAY_MS));
  return state0.interval === 0 ? "En cours" : `Dans ${days} j`;
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
    placeholder: "Rechercher en français ou en russe…",
    "aria-label": "Rechercher",
    value: vocabFilter.text
  });
  const listHost = h("div", {});
  const refresh = () => {
    const shown = allItems().filter(matchesFilter);
    listHost.replaceChildren(
      h("p", { class: "count-note" }, `${shown.length} sur ${allItems().length}`),
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
              ? h("button", { class: "btn danger", type: "button", onClick: () => removeCustom(item.id) }, "Supprimer")
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

  const kinds = [["all", "Tout"], ["word", "Mots"], ["phrase", "Phrases"], ["custom", "Mes mots"]];
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

  const frInput = h("input", { type: "text", placeholder: "Français (ex. un livre)", "aria-label": "Français", required: true });
  const ruInput = h("input", { type: "text", placeholder: "Russe (ex. книга)", "aria-label": "Russe", lang: "ru", required: true });
  const form = h(
    "form",
    { class: "add-form", onSubmit: (event) => {
      event.preventDefault();
      addCustom(frInput.value, ruInput.value);
    } },
    frInput,
    ruInput,
    h("button", { class: "btn primary", type: "submit" }, "Ajouter un mot")
  );

  refresh();
  return h("section", {}, h("div", { class: "toolbar" }, search, chips), listHost, form, h("p", { class: "count-note" }, `${items.length} entrées au total.`));
}

function addCustom(fr, ru) {
  const cleanFr = fr.trim();
  const cleanRu = ru.trim();
  if (!cleanFr || !cleanRu) return;
  const exists = allItems().some((item) => item.ru.toLocaleLowerCase() === cleanRu.toLocaleLowerCase());
  if (exists) {
    window.alert("Ce mot russe est déjà dans le vocabulaire.");
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
    { "aria-label": "Sens des cartes", onChange: (event) => update({ direction: event.target.value }) },
    Object.entries(DIRECTION_LABELS).map(([value, text]) => h("option", { value, selected: settings.direction === value }, text))
  );
  const voice = h(
    "select",
    { "aria-label": "Voix", onChange: (event) => update({ voice: event.target.value }) },
    Object.entries(VOICE_LABELS).map(([value, text]) => h("option", { value, selected: settings.voice === value }, text))
  );
  const rateLabel = h("span", {}, `${settings.rate.toFixed(2)}×`);
  const rate = h("input", {
    type: "range", min: "0.6", max: "1.2", step: "0.05", value: String(settings.rate), "aria-label": "Vitesse",
    onInput: (event) => {
      const value = Number(event.target.value);
      rateLabel.textContent = `${value.toFixed(2)}×`;
      update({ rate: value });
    }
  });
  const perDay = h("input", {
    type: "number", min: "0", max: "100", value: String(settings.newPerDay), "aria-label": "Nouvelles cartes par jour",
    onChange: (event) => update({ newPerDay: Math.max(0, Math.min(100, Math.round(Number(event.target.value) || 0))) })
  });
  const autoplay = h("input", {
    type: "checkbox", checked: settings.autoplay, "aria-label": "Lecture automatique",
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
      row("Sens des cartes", "Le changement de sens garde des progressions séparées.", direction),
      row("Nouvelles cartes par jour", null, perDay),
      row("Lecture automatique", "Prononce le russe dès qu’il apparaît.", autoplay),
      row("Voix", null, voice),
      row("Vitesse de la voix", null, h("div", {}, rate, " ", rateLabel))
    ),
    h("p", {}, h("button", { class: "btn danger", type: "button", onClick: resetProgress }, "Réinitialiser la progression"))
  );
}

function resetProgress() {
  if (!window.confirm("Effacer toute la progression ? Vos mots personnels sont conservés.")) return;
  state.schedules = {};
  state.introduced = {};
  state.log = {};
  session = null;
  scheduleSave();
  render();
}

// ---- shell -----------------------------------------------------------------
function render() {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  const content = view === "vocabulary" ? renderVocabulary() : view === "settings" ? renderSettings() : renderReview();
  app.replaceChildren(content);
}

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
    app.replaceChildren(h("p", { class: "empty" }, "Impossible de charger le vocabulaire. Lancez l’application avec le script de démarrage."));
  });
