// Calendar schedules: a five-field cron expression read in an IANA time zone.
//
//   minute  hour  day-of-month  month  day-of-week
//   0-59    0-23  1-31          1-12   0-6 (0 is Sunday; 7 is accepted as Sunday)
//
// Each field is `*`, a number, a range `a-b`, a step `*/n` or `a-b/n`, or a
// comma-separated list of those. Names (`MON`, `JAN`) and the `@daily`
// shorthands are not accepted.
//
// When both day-of-month and day-of-week are restricted, a day matches if
// either does. That is cron's own rule, kept so an expression means here what
// it means everywhere else.
//
// The daylight-saving contract, which a schedule's owner can rely on:
//   - A wall-clock time that does not exist on a day (clocks go forward) does
//     not fire on that day. It is not moved to the next hour.
//   - A wall-clock time that happens twice on a day (clocks go back) fires
//     once, at its first occurrence.

const FIELDS: readonly { readonly name: string; readonly min: number; readonly max: number }[] = [
  { name: 'minute', min: 0, max: 59 }, { name: 'hour', min: 0, max: 23 }, { name: 'day of month', min: 1, max: 31 }, { name: 'month', min: 1, max: 12 }, { name: 'day of week', min: 0, max: 7 },
];

export class CronError extends Error {}

export interface CronExpression {
  readonly minutes: readonly number[]; readonly hours: readonly number[]; readonly daysOfMonth: ReadonlySet<number>; readonly months: ReadonlySet<number>; readonly daysOfWeek: ReadonlySet<number>;
  /** Whether the expression restricts the day of the month, and the day of the week. Decides how the two combine. */
  readonly restrictsDayOfMonth: boolean; readonly restrictsDayOfWeek: boolean;
}

function field(text: string, index: number): number[] {
  const { name, min, max } = FIELDS[index]!; const values = new Set<number>();
  if (!text) throw new CronError(`The ${name} field is empty`);
  for (const part of text.split(',')) {
    const match = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) throw new CronError(`The ${name} field is not valid`);
    const step = match[4] === undefined ? 1 : Number(match[4]);
    if (step < 1) throw new CronError(`The ${name} field has a step of zero`);
    const from = match[1] === '*' ? min : Number(match[2]);
    // A single number with a step means "from that number to the end", as in cron.
    const to = match[1] === '*' ? max : match[3] !== undefined ? Number(match[3]) : match[4] !== undefined ? max : from;
    if (from < min || to > max || from > to) throw new CronError(`The ${name} field is out of range`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** Parses an expression, or throws `CronError` saying which field is wrong. */
export function parseCron(expression: string): CronExpression {
  if (typeof expression !== 'string' || expression.length > 100) throw new CronError('The schedule expression is too long');
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError('A schedule expression has five fields: minute, hour, day of month, month, day of week');
  const [minutes, hours, daysOfMonth, months, weekdays] = parts.map((part, index) => field(part, index)) as [number[], number[], number[], number[], number[]];
  const daysOfWeek = new Set(weekdays.map(day => day % 7));
  const parsed: CronExpression = { minutes, hours, daysOfMonth: new Set(daysOfMonth), months: new Set(months), daysOfWeek, restrictsDayOfMonth: parts[2] !== '*', restrictsDayOfWeek: parts[4] !== '*' };
  // An expression that can never fire (the 31st of February) is refused now, not discovered by a schedule that never runs.
  const reachable = [...parsed.months].some(month => [...parsed.daysOfMonth].some(day => day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!));
  if (!reachable && !(parsed.restrictsDayOfWeek && parsed.restrictsDayOfMonth)) throw new CronError('This schedule names a date that never occurs');
  return parsed;
}

/** True for a time zone this runtime knows. `UTC` is always one. */
export function validTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(timeZone)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true; } catch { return false; }
}

interface Local { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number }
const formatters = new Map<string, Intl.DateTimeFormat>();
function local(timeZone: string, instant: number): Local {
  let formatter = formatters.get(timeZone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }); formatters.set(timeZone, formatter); }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute! };
}
const asUtc = (value: Local) => Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
const same = (a: Local, b: Local) => a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;

const offsetAt = (timeZone: string, instant: number) => asUtc(local(timeZone, instant)) - instant;

/** The instants at which the zone's clocks read this wall time: none, one, or two when clocks go back. */
function instantsOf(timeZone: string, wall: Local, offsets: readonly number[]): number[] {
  const guess = asUtc(wall); const found = new Set<number>();
  for (const offset of offsets) { const candidate = guess - offset; if (same(local(timeZone, candidate), wall)) found.add(candidate); }
  return [...found].sort((a, b) => a - b);
}

/**
 * The first instant strictly after `after` at which the expression fires in the time zone, or null if there is none
 * within five years (which a valid expression always has).
 */
export function nextCronTime(expression: CronExpression, timeZone: string, after: Date): Date | null {
  if (!validTimeZone(timeZone)) throw new CronError('Unknown time zone');
  const start = local(timeZone, after.getTime());
  // Walk calendar days in the zone. Day arithmetic is done on a UTC date so it never meets a clock change.
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day));
  for (let days = 0; days < 1830; days++, cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const year = cursor.getUTCFullYear(); const month = cursor.getUTCMonth() + 1; const day = cursor.getUTCDate();
    if (!expression.months.has(month)) continue;
    const byMonthDay = expression.daysOfMonth.has(day); const byWeekDay = expression.daysOfWeek.has(cursor.getUTCDay());
    const matches = expression.restrictsDayOfMonth && expression.restrictsDayOfWeek ? byMonthDay || byWeekDay : byMonthDay && byWeekDay;
    if (!matches) continue;
    // The zone's offset before this day and after it. They differ only when the clocks change on or beside this day.
    const midnight = Date.UTC(year, month - 1, day); const before = offsetAt(timeZone, midnight - 86_400_000); const afterwards = offsetAt(timeZone, midnight + 2 * 86_400_000);
    for (const hour of expression.hours) for (const minute of expression.minutes) {
      const guess = Date.UTC(year, month - 1, day, hour, minute);
      // No zone is more than 14 hours from UTC, so this wall time is long past: not worth asking the calendar about.
      if (guess + 14 * 3_600_000 <= after.getTime()) continue;
      // An ordinary day has one offset and every wall time on it exists exactly once. Otherwise each wall time is
      // checked against the calendar, and when it happens twice only its first occurrence is a firing.
      const first = before === afterwards ? guess - before : instantsOf(timeZone, { year, month, day, hour, minute }, [before, afterwards])[0];
      if (first !== undefined && first > after.getTime()) return new Date(first);
    }
  }
  return null;
}
