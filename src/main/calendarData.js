// calendarData.js - Everything scheduled, laid out on a timeline.
//
// Tasks, backups and service-managed jobs each live on their own screen, so
// there was no way to see the night as a whole: what runs at 02:00, what piles
// up on the 1st, whether Sunday is empty. This produces occurrences for a date
// range so the UI can draw them.
//
// The future comes from cron expressions; the past comes from execution
// history, because what actually happened is more useful than what was meant
// to happen.
//
// Electron-free, so the service could serve it too.

// A per-minute cron would otherwise generate 1440 entries a day.
const MAX_OCCURRENCES_PER_SOURCE = 500;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function dayKey(d) {
  const x = new Date(d);
  // Local date, not ISO: a run at 21:00 belongs to that day for the operator,
  // whatever UTC thinks.
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** Everything with a schedule, in one shape. */
function collectSources(tasks, profiles) {
  const sources = [];

  for (const t of tasks || []) {
    if (!t || !t.CronExpression) continue;
    sources.push({
      id: t.Id,
      name: t.Name,
      cron: t.CronExpression,
      enabled: t.Enabled !== false,
      // An NSSM-managed task runs as its own Windows service.
      kind: t.ManagementMode === 'nssm' ? 'service' : 'task',
      page: t.ManagementMode === 'nssm' ? 'services' : 'tasks',
    });
  }

  for (const p of profiles || []) {
    if (!p || !p.CronExpression) continue;
    sources.push({
      id: p.Id,
      name: p.Name,
      cron: p.CronExpression,
      enabled: !!p.Enabled,
      kind: 'backup',
      page: 'backup',
    });
  }

  return sources;
}

/**
 * Scheduled occurrences between two dates.
 * Walks minute by minute, which is simple and exact; the horizon and the cap
 * keep it bounded.
 */
function futureOccurrences(cronParser, sources, from, to, options = {}) {
  const occurrences = [];
  const includeDisabled = !!options.includeDisabled;

  for (const source of sources) {
    if (!source.enabled && !includeDisabled) continue;

    let valid;
    try {
      const v = cronParser.validate(source.cron);
      valid = typeof v === 'boolean' ? v : !!(v && v.valid);
    } catch (e) { valid = false; }
    if (!valid) continue;

    const cursor = new Date(from);
    cursor.setSeconds(0, 0);
    let found = 0;

    while (cursor <= to && found < MAX_OCCURRENCES_PER_SOURCE) {
      if (cronParser.shouldRunAt(source.cron, cursor)) {
        occurrences.push({
          at: new Date(cursor).toISOString(),
          day: dayKey(cursor),
          id: source.id,
          name: source.name,
          kind: source.kind,
          page: source.page,
          cron: source.cron,
          enabled: source.enabled,
          state: 'scheduled',
        });
        found++;
      }
      cursor.setMinutes(cursor.getMinutes() + 1);
    }
  }

  return occurrences;
}

/** What actually ran, from history. */
function pastOccurrences(taskHistory, backupHistory, from, to) {
  const occurrences = [];
  const inRange = (ts) => {
    const d = new Date(ts);
    return !isNaN(d) && d >= from && d <= to;
  };

  for (const h of taskHistory || []) {
    if (!h || !h.Timestamp || !inRange(h.Timestamp)) continue;
    occurrences.push({
      at: new Date(h.Timestamp).toISOString(),
      day: dayKey(h.Timestamp),
      id: h.TaskId,
      name: h.TaskName,
      kind: 'task',
      page: 'tasks',
      state: h.Status === 'Success' ? 'success' : 'failed',
      duration: h.Duration || '',
      message: (h.Message || '').slice(0, 300),
      historyId: h.Id,
    });
  }

  for (const h of backupHistory || []) {
    if (!h || !h.Timestamp || !inRange(h.Timestamp)) continue;
    occurrences.push({
      at: new Date(h.Timestamp).toISOString(),
      day: dayKey(h.Timestamp),
      id: h.ProfileId,
      name: h.ProfileName,
      kind: 'backup',
      page: 'backup',
      state: h.Status === 'Success' ? 'success' : 'failed',
      duration: h.Duration || '',
      message: (h.TotalSizeHuman ? h.TotalSizeHuman + ' · ' : '') + (h.Status || ''),
      historyId: h.Id,
    });
  }

  return occurrences;
}

/**
 * Occurrences for a range, past and future.
 *
 * @returns { from, to, days: { 'YYYY-MM-DD': [occurrence] }, totals }
 */
function build(cronParser, data, range, options = {}) {
  const from = startOfDay(range.from);
  const to = endOfDay(range.to);
  const now = new Date();

  const sources = collectSources(data.tasks, data.profiles);

  // History for anything already past, cron projection for what is still to
  // come. A range spanning "now" gets both, split at this moment.
  const past = from < now
    ? pastOccurrences(data.taskHistory, data.backupHistory, from, to < now ? to : now)
    : [];
  const future = to > now
    ? futureOccurrences(cronParser, sources, from > now ? from : now, to, options)
    : [];

  const all = past.concat(future).sort((a, b) => new Date(a.at) - new Date(b.at));

  const days = {};
  for (const occurrence of all) {
    (days[occurrence.day] = days[occurrence.day] || []).push(occurrence);
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    days,
    totals: {
      scheduled: future.length,
      executed: past.filter(o => o.state === 'success').length,
      failed: past.filter(o => o.state === 'failed').length,
      sources: sources.length,
    },
  };
}

/** Load by hour of day, for spotting the crowded parts of the night. */
function hourHistogram(result) {
  const hours = new Array(24).fill(0);
  for (const list of Object.values(result.days || {})) {
    for (const occurrence of list) {
      hours[new Date(occurrence.at).getHours()]++;
    }
  }
  return hours;
}

module.exports = {
  build,
  collectSources,
  futureOccurrences,
  pastOccurrences,
  hourHistogram,
  dayKey,
  startOfDay,
  endOfDay,
  MAX_OCCURRENCES_PER_SOURCE,
};
