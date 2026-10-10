// Small SM-2 style scheduler: four grades, per-card ease, 10-minute relearn step.
export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * MINUTE_MS;
export const GRADES = ["again", "hard", "good", "easy"];

const RELEARN_MINUTES = 10;
const MIN_EASE = 1.3;
const START_EASE = 2.5;

export function newCardState() {
  return { ease: START_EASE, interval: 0, reps: 0, lapses: 0, due: 0, last: 0 };
}

function nextInterval(state, grade) {
  const base = state.interval;
  if (grade === "hard") return Math.max(1, Math.round(base * 1.2));
  if (grade === "good") {
    if (state.reps === 0) return 1;
    if (state.reps === 1) return 3;
    return Math.max(1, Math.round(base * state.ease));
  }
  // easy
  if (state.reps === 0) return 3;
  return Math.max(2, Math.round(base * state.ease * 1.3));
}

export function review(state, grade, now = Date.now()) {
  if (!GRADES.includes(grade)) throw new Error(`Unknown grade: ${grade}`);
  if (grade === "again") {
    return {
      ...state,
      ease: Math.max(MIN_EASE, state.ease - 0.2),
      interval: 0,
      reps: 0,
      lapses: state.lapses + 1,
      due: now + RELEARN_MINUTES * MINUTE_MS,
      last: now
    };
  }
  const interval = nextInterval(state, grade);
  const easeShift = grade === "hard" ? -0.15 : grade === "easy" ? 0.15 : 0;
  return {
    ...state,
    ease: Math.max(MIN_EASE, state.ease + easeShift),
    interval,
    reps: state.reps + 1,
    due: now + interval * DAY_MS,
    last: now
  };
}

function label(state, grade, now) {
  const next = review(state, grade, now);
  if (grade === "again") return `${RELEARN_MINUTES} min`;
  return `${next.interval} j`;
}

export function previewIntervals(state, now = Date.now()) {
  return Object.fromEntries(GRADES.map((grade) => [grade, label(state, grade, now)]));
}
