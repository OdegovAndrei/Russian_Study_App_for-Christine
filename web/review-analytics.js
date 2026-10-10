const DAY_MS = 24 * 60 * 60 * 1000;

let T = (key) => key;
let LOCALE = "fr-FR";

/** Plugs in the interface-language dictionary and the matching number/date locale. */
export function configureAnalytics({ translate, locale }) {
  T = translate;
  LOCALE = locale;
}

const CHART_LEFT = 50;
const CHART_RIGHT = 782;
const CHART_PLOT_WIDTH = CHART_RIGHT - CHART_LEFT;

const PLAN_BUCKETS = [
  { key: "today", get label() { return T("an.today"); }, color: "var(--review-plan-today)" },
  { key: "tomorrow", get label() { return T("an.tomorrow"); }, color: "var(--review-plan-tomorrow)" },
  { key: "days2to15", get label() { return T("an.days2to15"); }, color: "var(--review-plan-days2to15)" },
  { key: "later", get label() { return T("an.later"); }, color: "var(--review-plan-later)" }
];

const RATINGS = [
  { key: "again", get label() { return T("an.again"); }, color: "var(--rose)" },
  { key: "hard", get label() { return T("an.hard"); }, color: "var(--amber)" },
  { key: "good", get label() { return T("an.good"); }, color: "var(--accent)" },
  { key: "easy", get label() { return T("an.easy"); }, color: "var(--blue)" }
];

/**
 * Reconstructs the visible review-plan metrics for every day represented in
 * the answer log. The last point always uses the current schedule, so it also
 * includes cards which have not received their first answer yet.
 */
export function buildReviewPlanHistory({ cards = [], schedules = new Map(), logs = [], now = new Date() } = {}) {
  const safeNow = validDate(now) || new Date();
  const cardsById = new Map(asArray(cards).filter((card) => card?.id).map((card) => [card.id, card]));
  const cardIds = new Set(cardsById.keys());
  const events = asArray(logs)
    .filter((log) => cardIds.has(log?.cardId))
    .map((log) => ({
      ...log,
      noteId: cardsById.get(log.cardId)?.noteId || log.cardId,
      reviewedAtDate: validDate(log.reviewedAt),
      dueAfterDate: validDate(log.dueAfter)
    }))
    .filter((log) => log.reviewedAtDate && log.reviewedAtDate <= safeNow)
    .sort((first, second) => first.reviewedAtDate - second.reviewedAtDate);
  const firstDay = startOfDay(events[0]?.reviewedAtDate || safeNow);
  const lastDay = startOfDay(safeNow);
  const eventsByDay = new Map();
  for (const event of events) {
    const key = dateKey(event.reviewedAtDate);
    if (!eventsByDay.has(key)) eventsByDay.set(key, []);
    eventsByDay.get(key).push(event);
  }

  const scheduledCards = new Map();
  const history = [];
  for (let day = new Date(firstDay); day <= lastDay; day = addDays(day, 1)) {
    const activity = emptyActivity();
    const introducedNoteIds = new Set();
    for (const event of eventsByDay.get(dateKey(day)) || []) {
      activity.reviews += 1;
      if (event.wasNew) introducedNoteIds.add(event.noteId);
      if (RATINGS.some((rating) => rating.key === event.rating)) activity[event.rating] += 1;
      if (event.dueAfterDate) scheduledCards.set(event.cardId, { due: event.dueAfterDate });
    }
    activity.introduced = introducedNoteIds.size;
    history.push({
      date: new Date(day),
      ...buildPlanPoint([...scheduledCards.values()], endOfDay(day)),
      ...activity
    });
  }

  const currentActivity = history.at(-1) ? pickActivity(history.at(-1)) : emptyActivity();
  const currentSchedules = asArray(cards).map((card) => scheduleFor(schedules, card?.id));
  const currentPoint = {
    date: new Date(lastDay),
    ...buildPlanPoint(currentSchedules, safeNow),
    ...currentActivity
  };
  if (history.length) history[history.length - 1] = currentPoint;
  else history.push(currentPoint);

  return { history, hasHistory: events.length > 0 };
}

export function buildReviewLoadForecast({ cards = [], schedules = new Map(), now = new Date(), days = 14 } = {}) {
  const safeNow = validDate(now) || new Date();
  const dayCount = Math.max(1, Math.floor(days) || 14);
  const start = startOfDay(safeNow);
  const forecast = Array.from({ length: dayCount }, (_, index) => ({ date: addDays(start, index), count: 0 }));
  let unscheduled = 0;

  for (const card of asArray(cards)) {
    const schedule = scheduleFor(schedules, card?.id);
    if (isNewSchedule(schedule)) {
      unscheduled += 1;
      continue;
    }
    const due = validDate(schedule?.due);
    if (!due) continue;
    const index = Math.floor((startOfDay(due).getTime() - start.getTime()) / DAY_MS);
    if (index < 0) forecast[0].count += 1;
    else if (index < dayCount) forecast[index].count += 1;
  }

  return { days: forecast, unscheduled, total: forecast.reduce((sum, day) => sum + day.count, 0) };
}

export function openReviewAnalyticsModal({ modalRoot, cards, schedules, logs, opener } = {}) {
  if (!modalRoot) return;
  const { history, hasHistory } = buildReviewPlanHistory({ cards, schedules, logs });
  const forecast = buildReviewLoadForecast({ cards, schedules });
  let range = "all";
  let selectedIndex = Math.max(0, history.length - 1);
  let close = () => {};

  modalRoot.innerHTML = `
    <div class="modal-backdrop review-analytics-backdrop">
      <section class="modal-panel review-analytics-modal" role="dialog" aria-modal="true" aria-labelledby="review-analytics-title">
        <div class="review-analytics-heading">
          <div>
            <p class="eyebrow">${T("an.historyEyebrow")}</p>
            <h4 id="review-analytics-title">${T("an.title")}</h4>
          </div>
          <button class="modal-close" type="button" aria-label="${T("an.close")}">×</button>
        </div>
        <div class="review-analytics-content"></div>
      </section>
    </div>`;

  const backdrop = modalRoot.querySelector(".review-analytics-backdrop");
  const content = modalRoot.querySelector(".review-analytics-content");
  const onKeyDown = (event) => {
    if (event.key === "Escape") close();
  };
  close = () => {
    document.removeEventListener("keydown", onKeyDown);
    modalRoot.replaceChildren();
    opener?.focus();
  };

  const render = () => {
    const points = selectRange(history, range);
    selectedIndex = clamp(selectedIndex, 0, Math.max(0, points.length - 1));
    content.innerHTML = renderAnalyticsContent({ points, range, hasHistory, selectedIndex, forecast });
    content.querySelectorAll("[data-review-analytics-range]").forEach((button) => {
      button.addEventListener("click", () => {
        range = button.dataset.reviewAnalyticsRange;
        selectedIndex = Math.max(0, selectRange(history, range).length - 1);
        render();
      });
    });
    const slider = content.querySelector("[data-review-analytics-day]");
    const selectedDate = content.querySelector("[data-review-analytics-selected-date]");
    const updateSelection = (nextIndex) => {
      selectedIndex = clamp(nextIndex, 0, Math.max(0, points.length - 1));
      const point = points[selectedIndex] || emptyPoint(new Date());
      slider.value = String(selectedIndex);
      slider.setAttribute("aria-valuetext", formatDate(point.date));
      selectedDate.textContent = formatDate(point.date);
      content.querySelector("[data-review-analytics-selected-point]").innerHTML = renderSelectedPoint(point);
      updateChartMarkers(content, selectedIndex);
    };
    slider.addEventListener("input", () => updateSelection(Number(slider.value)));
    slider.addEventListener("keydown", (event) => {
      const keyboardStep = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -7, PageUp: 7 };
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? points.length - 1
          : Number.isFinite(keyboardStep[event.key])
            ? selectedIndex + keyboardStep[event.key]
            : null;
      if (nextIndex == null) return;
      event.preventDefault();
      updateSelection(nextIndex);
    });
    content.querySelectorAll("[data-review-analytics-chart]").forEach((chart) => {
      const selectFromPointer = (event) => updateSelection(chartPointFromPointer(event, points.length));
      chart.addEventListener("pointermove", selectFromPointer);
      chart.addEventListener("click", selectFromPointer);
    });
  };

  modalRoot.querySelector(".modal-close").addEventListener("click", close);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener("keydown", onKeyDown);
  render();
  modalRoot.querySelector(".modal-close").focus();
}

function renderAnalyticsContent({ points, range, hasHistory, selectedIndex, forecast }) {
  const current = points.at(-1) || emptyPoint(new Date());
  const first = points[0] || current;
  const selected = points[selectedIndex] || current;
  const currentShare = (count) => current.total ? (count / current.total) * 100 : 0;
  return `
    <div class="review-analytics-range" role="group" aria-label="${T("an.period")}">
      ${renderRangeButton("30", T("an.d30"), range)}
      ${renderRangeButton("90", T("an.d90"), range)}
      ${renderRangeButton("all", T("an.all"), range)}
    </div>
    <div class="review-analytics-stats" aria-label="${T("an.currentPlan")}">
      ${renderStat(T("an.inPlan"), formatCount(current.total), T("an.perPeriod", { n: formatSigned(current.total - first.total) }))}
      ${renderStat(T("an.today"), formatCount(current.today), T("an.ofPlan", { p: formatPercent(currentShare(current.today)) }))}
      ${renderStat(T("an.avg"), formatDays(current.averageRemainingDays), T("an.perPeriod", { n: formatSigned(current.averageRemainingDays - first.averageRemainingDays, ` ${T("an.dayShort")}`) }))}
      ${renderStat(T("an.answersToday"), formatCount(current.reviews), current.reviews ? T("an.confident", { p: formatPercent((current.good + current.easy) / current.reviews * 100) }) : T("an.none"))}
    </div>
    <div class="review-analytics-selection-control">
      <label for="review-analytics-day">${T("an.selectedDay")} <output data-review-analytics-selected-date>${formatDate(selected.date)}</output></label>
      <input id="review-analytics-day" type="range" min="0" max="${Math.max(0, points.length - 1)}" value="${selectedIndex}" step="1" data-review-analytics-day aria-valuetext="${formatDate(selected.date)}" />
    </div>
    <div class="review-analytics-selection" data-review-analytics-selected-point aria-live="polite">${renderSelectedPoint(selected)}</div>
    ${hasHistory ? "" : `<p class="note review-analytics-note">${T("an.onlySnapshot")}</p>`}
    <section class="review-analytics-section" aria-labelledby="review-analytics-absolute-title">
      <div class="review-analytics-section-heading">
        <div><p class="eyebrow">${T("an.absEyebrow")}</p><h5 id="review-analytics-absolute-title">${T("an.absTitle")}</h5></div>
        ${renderLegend(PLAN_BUCKETS)}
      </div>
      ${renderStackedPlanChart(points, false, selectedIndex)}
    </section>
    <section class="review-analytics-section" aria-labelledby="review-analytics-relative-title">
      <div class="review-analytics-section-heading">
        <div><p class="eyebrow">${T("an.relEyebrow")}</p><h5 id="review-analytics-relative-title">${T("an.relTitle")}</h5></div>
        ${renderLegend(PLAN_BUCKETS)}
      </div>
      ${renderStackedPlanChart(points, true, selectedIndex)}
    </section>
    <section class="review-analytics-section" aria-labelledby="review-analytics-interval-title">
      <div class="review-analytics-section-heading"><div><p class="eyebrow">${T("an.avgEyebrow")}</p><h5 id="review-analytics-interval-title">${T("an.avgTitle")}</h5></div></div>
      ${renderAverageTimingChart(points, selectedIndex)}
    </section>
    <section class="review-analytics-section" aria-labelledby="review-analytics-new-title">
      <div class="review-analytics-section-heading">
        <div><p class="eyebrow">${T("an.newEyebrow")}</p><h5 id="review-analytics-new-title">${T("an.newTitle")}</h5></div>
      </div>
      ${renderNewWordsChart(points, selectedIndex)}
    </section>
    <section class="review-analytics-section" aria-labelledby="review-analytics-answers-title">
      <div class="review-analytics-section-heading">
        <div><p class="eyebrow">${T("an.actEyebrow")}</p><h5 id="review-analytics-answers-title">${T("an.actTitle")}</h5></div>
        ${renderLegend(RATINGS)}
      </div>
      ${renderAnswerChart(points, selectedIndex)}
    </section>
    <section class="review-analytics-section" aria-labelledby="review-analytics-forecast-title">
      <div class="review-analytics-section-heading"><div><p class="eyebrow">${T("an.fcEyebrow")}</p><h5 id="review-analytics-forecast-title">${T("an.fcTitle")}</h5></div></div>
      ${renderForecastChart(forecast)}
      <p class="note review-analytics-note">${T("an.forecastNote", { n: formatScheduledReviews(forecast.total) })} ${forecast.unscheduled ? T("an.unscheduled", { n: formatNewCards(forecast.unscheduled) }) : T("an.allScheduled")}</p>
    </section>
    <p class="note review-analytics-note">${T("an.historyNote")}</p>`;
}

function renderSelectedPoint(point) {
  const plan = PLAN_BUCKETS.map((bucket) => `${bucket.label}: <strong>${formatCount(point[bucket.key])}</strong> (${formatPercent(point.total ? point[bucket.key] / point.total * 100 : 0)})`).join(" · ");
  const answers = point.reviews
    ? T("an.answersN", { n: formatCount(point.reviews), detail: RATINGS.map((rating) => `${rating.label.toLowerCase()} ${point[rating.key]}`).join(", ") })
    : T("an.noAnswers");
  return `<strong>${formatDate(point.date)}</strong><span>${plan}</span><span>${T("an.avgTerm")} <strong>${formatDays(point.averageRemainingDays)}</strong> · ${answers}</span>`;
}

function renderRangeButton(value, label, range) {
  return `<button class="secondary-button ${range === value ? "active" : ""}" type="button" data-review-analytics-range="${value}" aria-pressed="${range === value}">${label}</button>`;
}

function renderStat(label, value, detail) {
  return `<div class="review-analytics-stat"><span>${label}</span><strong>${value}</strong><small>${detail}</small></div>`;
}

function renderLegend(items) {
  return `<ul class="review-analytics-legend" aria-label="${T("an.legend")}">${items.map((item) => `<li><i style="--review-analytics-color: ${item.color}"></i>${item.label}</li>`).join("")}</ul>`;
}

function renderStackedPlanChart(points, relative, selectedIndex) {
  const maximum = relative ? 100 : Math.max(1, ...points.map((point) => point.total));
  const ticks = relative ? [0, 50, 100] : chartTicks(maximum);
  const chart = chartFrame({
    points,
    label: T(relative ? "an.relLabel" : "an.absLabel"),
    description: T(relative ? "an.relDesc" : "an.absDesc"),
    maximum,
    ticks
  });
  const bars = points.map((point, index) => {
    const { x, width } = chart.bar(index);
    let used = 0;
    const segments = PLAN_BUCKETS.map((bucket) => {
      const amount = relative ? (point.total ? point[bucket.key] / point.total * 100 : 0) : point[bucket.key];
      const height = amount / maximum * chart.height;
      const y = chart.top + chart.height - used - height;
      used += height;
      return height > 0 ? `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${bucket.color}"></rect>` : "";
    }).join("");
    return `<g><title>${planTooltip(point, relative)}</title>${segments}</g>`;
  }).join("");
  return `${chart.open}${chart.grid}${bars}${renderChartMarker(chart, selectedIndex)}${chart.axis}${chart.close}`;
}

function renderAverageTimingChart(points, selectedIndex) {
  const maximum = Math.max(1, ...points.map((point) => point.averageRemainingDays));
  const chart = chartFrame({
    points,
    label: T("an.avgLabel"),
    description: T("an.avgDesc"),
    maximum,
    ticks: chartTicks(maximum)
  });
  const polyline = points.map((point, index) => `${chart.center(index)},${chart.y(point.averageRemainingDays)}`).join(" ");
  const current = points.at(-1);
  const marker = current ? `<g><title>${formatDate(current.date)}: ${formatDays(current.averageRemainingDays)}</title><circle cx="${chart.center(points.length - 1)}" cy="${chart.y(current.averageRemainingDays)}" r="4" fill="var(--surface)" stroke="var(--accent-dark)" stroke-width="2"></circle></g>` : "";
  const currentLabel = current ? `<text class="review-analytics-value-label" x="${chart.right}" y="${Math.max(chart.top + 11, chart.y(current.averageRemainingDays) - 8)}" text-anchor="end">${formatDays(current.averageRemainingDays)}</text>` : "";
  return `${chart.open}${chart.grid}<polyline points="${polyline}" fill="none" stroke="var(--accent-dark)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>${marker}${currentLabel}${renderChartMarker(chart, selectedIndex)}${chart.axis}${chart.close}`;
}

function renderNewWordsChart(points, selectedIndex) {
  const maximum = Math.max(1, ...points.map((point) => point.introduced));
  const chart = chartFrame({
    points,
    label: T("an.newLabel"),
    description: T("an.newDesc"),
    maximum,
    ticks: chartTicks(maximum)
  });
  const bars = points.map((point, index) => {
    const { x, width } = chart.bar(index);
    const height = point.introduced / maximum * chart.height;
    const y = chart.top + chart.height - height;
    return `<g><title>${formatDate(point.date)}: ${formatNoteCount(point.introduced)}</title>${height ? `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="var(--blue)"></rect>` : ""}</g>`;
  }).join("");
  return `${chart.open}${chart.grid}${bars}${renderChartMarker(chart, selectedIndex)}${chart.axis}${chart.close}`;
}

function renderAnswerChart(points, selectedIndex) {
  const maximum = Math.max(1, ...points.map((point) => point.reviews));
  const chart = chartFrame({
    points,
    label: T("an.ansLabel"),
    description: T("an.ansDesc"),
    maximum,
    ticks: chartTicks(maximum)
  });
  const bars = points.map((point, index) => {
    const { x, width } = chart.bar(index);
    let used = 0;
    const segments = RATINGS.map((rating) => {
      const height = point[rating.key] / maximum * chart.height;
      const y = chart.top + chart.height - used - height;
      used += height;
      return height > 0 ? `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${rating.color}"></rect>` : "";
    }).join("");
    return `<g><title>${answerTooltip(point)}</title>${segments}</g>`;
  }).join("");
  return `${chart.open}${chart.grid}${bars}${renderChartMarker(chart, selectedIndex)}${chart.axis}${chart.close}`;
}

function renderForecastChart(forecast) {
  const points = forecast.days;
  const maximum = Math.max(1, ...points.map((point) => point.count));
  const chart = chartFrame({
    points,
    label: T("an.fcLabel"),
    description: T("an.fcDesc"),
    maximum,
    ticks: chartTicks(maximum),
    interactive: false
  });
  const bars = points.map((point, index) => {
    const { x, width } = chart.bar(index);
    const height = point.count / maximum * chart.height;
    const y = chart.top + chart.height - height;
    return `<g><title>${formatDate(point.date)}: ${formatReviewCount(point.count)}</title>${height ? `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="var(--accent-dark)"></rect>` : ""}</g>`;
  }).join("");
  return `${chart.open}${chart.grid}${bars}${chart.axis}${chart.close}`;
}

function renderChartMarker(chart, selectedIndex) {
  const x = chart.center(selectedIndex);
  return `<line class="review-analytics-selected-marker" data-review-analytics-marker x1="${x}" x2="${x}" y1="${chart.top}" y2="${chart.top + chart.height}"></line>`;
}

function chartFrame({ points, label, description, maximum, ticks, interactive = true }) {
  const width = 800;
  const top = 12;
  const left = CHART_LEFT;
  const right = width - CHART_RIGHT;
  const bottom = 35;
  const height = 170;
  const plotWidth = CHART_PLOT_WIDTH;
  const y = (value) => top + height - (Math.max(0, value) / maximum * height);
  const center = (index) => points.length <= 1
    ? left + plotWidth / 2
    : left + index / (points.length - 1) * plotWidth;
  const bar = (index) => {
    const step = points.length <= 1 ? Math.min(34, plotWidth) : plotWidth / points.length;
    const width = Math.max(1, Math.min(28, step * 0.78));
    return { x: center(index) - width / 2, width };
  };
  const grid = ticks.map((tick) => `<g><line x1="${left}" x2="${width - right}" y1="${y(tick)}" y2="${y(tick)}"></line><text x="${left - 8}" y="${y(tick) + 4}" text-anchor="end">${formatAxisTick(tick, maximum === 100)}</text></g>`).join("");
  const axis = `${dateAxis(points, center, top + height + 21)}<line x1="${left}" x2="${width - right}" y1="${top + height}" y2="${top + height}"></line>`;
  return {
    top,
    height,
    right: width - right,
    y,
    center,
    bar,
    open: `<svg class="review-analytics-chart" ${interactive ? `data-review-analytics-chart data-review-analytics-point-count="${points.length}"` : ""} viewBox="0 0 ${width} ${top + height + bottom}" role="img" aria-label="${label}"><title>${label}</title><desc>${description}</desc>`,
    grid: `<g class="review-analytics-grid">${grid}</g>`,
    axis: `<g class="review-analytics-axis">${axis}</g>`,
    close: "</svg>"
  };
}

function updateChartMarkers(root, selectedIndex) {
  root.querySelectorAll("[data-review-analytics-marker]").forEach((marker) => {
    const pointCount = Number(marker.closest("[data-review-analytics-chart]")?.dataset.reviewAnalyticsPointCount) || 1;
    const x = chartPointX(selectedIndex, pointCount);
    marker.setAttribute("x1", String(x));
    marker.setAttribute("x2", String(x));
  });
}

function chartPointFromPointer(event, pointCount) {
  const bounds = event.currentTarget.getBoundingClientRect();
  if (!bounds.width || pointCount <= 1) return 0;
  const chartX = (event.clientX - bounds.left) / bounds.width * 800;
  const fraction = (chartX - CHART_LEFT) / CHART_PLOT_WIDTH;
  return Math.round(clamp(fraction, 0, 1) * (pointCount - 1));
}

function chartPointX(index, pointCount) {
  return pointCount <= 1
    ? CHART_LEFT + CHART_PLOT_WIDTH / 2
    : CHART_LEFT + clamp(index, 0, pointCount - 1) / (pointCount - 1) * CHART_PLOT_WIDTH;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function dateAxis(points, center, y) {
  const indexes = [...new Set([0, Math.round((points.length - 1) / 2), points.length - 1])];
  return indexes.map((index) => {
    const point = points[index];
    return point ? `<text x="${center(index)}" y="${y}" text-anchor="middle">${formatShortDate(point.date)}</text>` : "";
  }).join("");
}

function buildPlanPoint(scheduleEntries, now) {
  const buckets = { today: 0, tomorrow: 0, days2to15: 0, later: 0 };
  let totalRemainingDays = 0;
  const tomorrow = startOfDay(addDays(now, 1)).getTime();
  const inTwoDays = startOfDay(addDays(now, 2)).getTime();
  const inSixteenDays = startOfDay(addDays(now, 16)).getTime();
  for (const schedule of scheduleEntries) {
    if (isNewSchedule(schedule)) {
      buckets.today += 1;
      continue;
    }
    const due = validDate(schedule?.due)?.getTime();
    if (!due || due < tomorrow) buckets.today += 1;
    else if (due < inTwoDays) buckets.tomorrow += 1;
    else if (due < inSixteenDays) buckets.days2to15 += 1;
    else buckets.later += 1;
    totalRemainingDays += Math.max(0, (due - now.getTime()) / DAY_MS);
  }
  const total = scheduleEntries.length;
  return { ...buckets, total, averageRemainingDays: total ? totalRemainingDays / total : 0 };
}

function selectRange(history, range) {
  if (range === "30") return history.slice(-30);
  if (range === "90") return history.slice(-90);
  return history;
}

function scheduleFor(schedules, id) {
  if (!id) return null;
  if (schedules instanceof Map) return schedules.get(id) || null;
  if (typeof schedules?.get === "function") return schedules.get(id) || null;
  return schedules?.[id] || null;
}

function isNewSchedule(schedule) {
  return !schedule || !schedule.due;
}

function emptyActivity() {
  return { reviews: 0, introduced: 0, again: 0, hard: 0, good: 0, easy: 0 };
}

function pickActivity(point) {
  return Object.fromEntries(Object.keys(emptyActivity()).map((key) => [key, point[key] || 0]));
}

function emptyPoint(date) {
  return { date, ...buildPlanPoint([], date), ...emptyActivity() };
}

function chartTicks(maximum) {
  const rounded = Math.max(1, Math.ceil(maximum));
  return [0, Math.ceil(rounded / 2), rounded];
}

function planTooltip(point, relative) {
  const values = PLAN_BUCKETS.map((bucket) => {
    const value = relative && point.total ? point[bucket.key] / point.total * 100 : point[bucket.key];
    return `${bucket.label}: ${relative ? formatPercent(value) : formatCount(value)}`;
  });
  return `${formatDate(point.date)}. ${values.join(", ")}`;
}

function answerTooltip(point) {
  return `${formatDate(point.date)}. ${T("an.answersCount", { n: point.reviews })} ${RATINGS.map((rating) => `${rating.label}: ${point[rating.key]}`).join(", ")}`;
}

function formatCount(value) {
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(value || 0);
}

function isSingular(value) {
  return Math.abs(Math.round(Number(value) || 0)) <= 1;
}

function formatNoteCount(value) {
  return `${formatCount(value)} ${T(isSingular(value) ? "an.noteOne" : "an.noteMany")}`;
}

function formatReviewCount(value) {
  return `${formatCount(value)} ${T(isSingular(value) ? "an.reviewOne" : "an.reviewMany")}`;
}

function formatScheduledReviews(value) {
  return `${formatCount(value)} ${T(isSingular(value) ? "an.scheduledOne" : "an.scheduledMany")}`;
}

function formatNewCards(value) {
  return `${formatCount(value)} ${T(isSingular(value) ? "an.cardOne" : "an.cardMany")}`;
}

function formatDays(value) {
  return `${new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0)} ${T("an.dayShort")}`;
}

function formatPercent(value) {
  return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 }).format(value || 0)}%`;
}

function formatAxisTick(value, percent) {
  return percent ? `${value}%` : formatCount(value);
}

function formatSigned(value, suffix = "") {
  const rounded = Math.abs(value) < 0.005 ? 0 : value;
  const formatted = suffix ? new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(rounded)) : formatCount(Math.abs(rounded));
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : "±"}${formatted}${suffix}`;
}

function formatDate(date) {
  return new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "long", year: "numeric" }).format(date);
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short" }).format(date);
}

function validDate(value) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function startOfDay(value) {
  const date = validDate(value) || new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfDay(value) {
  const date = startOfDay(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

function addDays(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function dateKey(value) {
  const date = validDate(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
