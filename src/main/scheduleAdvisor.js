// scheduleAdvisor.js - Warns about schedules that collide, and finds a free slot.
//
// Two heavy jobs firing in the same minute is a real operational problem: a
// backup and a task both hitting the same database at 02:00 turn a fast night
// into a slow one, and nothing in the UI used to hint at it. This compares a
// candidate expression against everything already scheduled and reports the
// overlaps before the user saves.
//
// Comparison is done on actual fire times, not on the text of the expression,
// so "0 2 * * *" and "*/30 2 * * *" are correctly seen as colliding.

const DEFAULT_HORIZON_HOURS = 24 * 7;   // a week covers weekly schedules
const MAX_SAMPLES = 400;                // ceiling per schedule, so a per-minute
                                        // cron cannot make this unbounded

/**
 * Minutes at which an expression fires inside the horizon.
 * Returned as "minute keys" (ms since epoch, truncated to the minute) so two
 * schedules can be intersected cheaply.
 */
function fireTimes(cronParser, expression, options = {}) {
  const horizonHours = options.horizonHours || DEFAULT_HORIZON_HOURS;
  const from = options.from ? new Date(options.from) : new Date();

  const start = new Date(from);
  start.setSeconds(0, 0);

  const times = new Set();
  if (!expression) return times;

  // CronParser.validate returns a bare boolean here, but other call sites in
  // the codebase expect { valid }. Accept both rather than depending on one.
  const validation = cronParser.validate(expression);
  const isValid = typeof validation === 'boolean' ? validation : !!(validation && validation.valid);
  if (!isValid) return times;

  const totalMinutes = horizonHours * 60;
  const cursor = new Date(start);

  for (let i = 0; i < totalMinutes && times.size < MAX_SAMPLES; i++) {
    if (cronParser.shouldRunAt(expression, cursor)) {
      times.add(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return times;
}

/**
 * Which existing schedules fire at the same minute as `expression`.
 *
 * @param cronParser
 * @param expression   the candidate being edited
 * @param schedules    [{ id, name, cron, kind }]
 * @param options      { excludeId, horizonHours, from }
 * @returns [{ id, name, kind, cron, at, sharedCount }]
 */
function findConflicts(cronParser, expression, schedules, options = {}) {
  const mine = fireTimes(cronParser, expression, options);
  if (!mine.size) return [];

  const conflicts = [];
  for (const schedule of schedules || []) {
    if (!schedule || !schedule.cron) continue;
    // Editing an item must not report it as colliding with itself.
    if (options.excludeId && schedule.id === options.excludeId) continue;

    const theirs = fireTimes(cronParser, schedule.cron, options);
    const shared = [];
    for (const t of theirs) {
      if (mine.has(t)) shared.push(t);
      if (shared.length >= 5) break;
    }

    if (shared.length) {
      shared.sort((a, b) => a - b);
      conflicts.push({
        id: schedule.id,
        name: schedule.name,
        kind: schedule.kind || 'task',
        cron: schedule.cron,
        at: new Date(shared[0]).toISOString(),
        sharedCount: shared.length,
      });
    }
  }

  // Soonest collision first - that is the one the operator cares about.
  conflicts.sort((a, b) => new Date(a.at) - new Date(b.at));
  return conflicts;
}

/**
 * Suggest a nearby minute that collides with nothing.
 *
 * Only the MINUTE field is moved: the user chose "every day at 2am" for a
 * reason, and shifting the hour or the weekday would quietly change what they
 * asked for. Shifting 02:00 to 02:07 keeps the intent and removes the clash.
 *
 * Returns null when the expression has no single literal minute (for example
 * "*\/5 * * * *"), because there is no honest small change to offer.
 */
function suggestFreeSlot(cronParser, expression, schedules, options = {}) {
  const parts = String(expression || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const minuteField = parts[0];
  if (!/^\d{1,2}$/.test(minuteField)) return null;   // not a single fixed minute

  const currentMinute = parseInt(minuteField, 10);
  if (isNaN(currentMinute) || currentMinute > 59) return null;

  // Try minutes in order of distance, so the suggestion stays close to the
  // time the user actually wanted.
  const order = [];
  for (let delta = 1; delta <= 59; delta++) {
    const up = (currentMinute + delta) % 60;
    const down = (currentMinute - delta + 60) % 60;
    if (!order.includes(up)) order.push(up);
    if (!order.includes(down)) order.push(down);
  }

  for (const minute of order) {
    const candidate = [String(minute), ...parts.slice(1)].join(' ');
    const conflicts = findConflicts(cronParser, candidate, schedules, options);
    if (!conflicts.length) {
      return {
        expression: candidate,
        minute,
        movedBy: Math.min(Math.abs(minute - currentMinute), 60 - Math.abs(minute - currentMinute)),
      };
    }
  }

  return null;
}

/** Flatten tasks and backup profiles into one comparable list. */
function collectSchedules(tasks, profiles) {
  const list = [];
  for (const t of tasks || []) {
    if (t && t.CronExpression && t.Enabled !== false) {
      list.push({ id: t.Id, name: t.Name, cron: t.CronExpression, kind: 'task' });
    }
  }
  for (const p of profiles || []) {
    if (p && p.CronExpression && p.Enabled) {
      list.push({ id: p.Id, name: p.Name, cron: p.CronExpression, kind: 'backup' });
    }
  }
  return list;
}

module.exports = {
  fireTimes,
  findConflicts,
  suggestFreeSlot,
  collectSchedules,
  DEFAULT_HORIZON_HOURS,
  MAX_SAMPLES,
};
