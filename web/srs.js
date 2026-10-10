// Spaced repetition, ported from the original French/Russian Study apps:
// the FSRS scheduler (ts-fsrs, 90% target retention, default learning steps)
// and the same queue order (learning cards first, then the oldest due,
// then new cards).
//
// A stored schedule is a plain object with `due` and `last_review` as
// millisecond timestamps. A card without a schedule is new.
import { Rating, State, createEmptyCard, fsrs } from "./vendor/ts-fsrs/index.mjs";

export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * MINUTE_MS;
export const GRADES = ["again", "hard", "good", "easy"];

const RATINGS = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy
};

export function createScheduler(options = {}) {
  return fsrs({ request_retention: 0.9, ...options });
}

const scheduler = createScheduler();

function toCard(schedule, now) {
  if (!schedule) return createEmptyCard(new Date(now));
  return {
    ...schedule,
    due: new Date(schedule.due),
    last_review: schedule.last_review ? new Date(schedule.last_review) : undefined
  };
}

function toStored(card) {
  return {
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review ? card.last_review.getTime() : null
  };
}

export function isNewSchedule(schedule) {
  return !schedule || schedule.state === State.New || schedule.reps === 0;
}

export function isDueSchedule(schedule, now = Date.now()) {
  return Boolean(schedule) && !isNewSchedule(schedule) && schedule.due <= now;
}

export function isLearningSchedule(schedule) {
  return schedule?.state === State.Learning || schedule?.state === State.Relearning;
}

/** Applies a grade. Returns the new schedule and a log entry for the statistics. */
export function review(schedule, grade, now = Date.now()) {
  const rating = RATINGS[grade];
  if (!rating) throw new Error(`Unknown grade: ${grade}`);
  const wasNew = isNewSchedule(schedule);
  const input = toCard(schedule, now);
  const result = scheduler.next(input, new Date(now), rating);
  const next = toStored(result.card);
  return {
    schedule: next,
    log: {
      rating: grade,
      wasNew,
      reviewedAt: now,
      dueBefore: wasNew ? null : input.due.getTime(),
      dueAfter: next.due,
      stateBefore: result.log.state,
      scheduledDays: result.log.scheduled_days,
      stability: result.log.stability,
      difficulty: result.log.difficulty
    }
  };
}

const DEFAULT_UNITS = { min: "min", hour: "h", day: "d", month: "mo", year: "y" };

export function formatInterval(milliseconds, units = DEFAULT_UNITS) {
  const minutes = Math.max(1, Math.round(milliseconds / MINUTE_MS));
  if (minutes < 60) return `${minutes} ${units.min}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${units.hour}`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} ${units.day}`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} ${units.month}`;
  return `${Math.round(days / 365)} ${units.year}`;
}

/** What each button would schedule, as short labels. */
export function previewIntervals(schedule, now = Date.now(), units = DEFAULT_UNITS) {
  const preview = scheduler.repeat(toCard(schedule, now), new Date(now));
  return Object.fromEntries(
    GRADES.map((grade) => [grade, formatInterval(preview[RATINGS[grade]].card.due.getTime() - now, units)])
  );
}

/**
 * Cards due now, learning cards first and then the oldest due date, followed
 * by every card that has never been answered, in deck order.
 * `schedules` is an object keyed by card key.
 */
export function buildReviewQueue({ cards, schedules, now = Date.now() }) {
  const due = cards
    .filter((card) => isDueSchedule(schedules[card.key], now))
    .sort((left, right) => {
      const priority = Number(isLearningSchedule(schedules[right.key])) - Number(isLearningSchedule(schedules[left.key]));
      return priority || schedules[left.key].due - schedules[right.key].due;
    });
  const fresh = cards.filter((card) => isNewSchedule(schedules[card.key]));
  return [...due, ...fresh];
}

/** Converts a schedule written by the earlier SM-2 style version; FSRS data is returned unchanged. */
export function migrateSchedule(schedule) {
  if (!schedule || schedule.state !== undefined) return schedule;
  const interval = Number(schedule.interval) || 0;
  const ease = Number(schedule.ease) || 2.5;
  return {
    due: schedule.due,
    stability: Math.max(interval, 0.5),
    difficulty: Math.min(10, Math.max(1, 5 + (2.5 - ease) * 5)),
    elapsed_days: 0,
    scheduled_days: interval,
    learning_steps: 0,
    reps: Math.max(1, Number(schedule.reps) || 0),
    lapses: Number(schedule.lapses) || 0,
    state: interval === 0 ? State.Learning : State.Review,
    last_review: schedule.last || null
  };
}
