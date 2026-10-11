import { describe, expect, test } from 'bun:test';
import { CronError, nextCronTime, parseCron, validTimeZone } from '../domain/CronSchedule.ts';

const next = (expression: string, zone: string, after: string) => nextCronTime(parseCron(expression), zone, new Date(after))?.toISOString() ?? null;
/** Every firing from `after` up to and not including `until`. */
const firings = (expression: string, zone: string, after: string, until: string) => {
  const out: string[] = []; let at = new Date(after); const parsed = parseCron(expression);
  for (;;) { const found = nextCronTime(parsed, zone, at); if (!found || found.getTime() >= new Date(until).getTime()) return out; out.push(found.toISOString()); at = found; }
};

describe('cron expressions', () => {
  test('each field takes numbers, ranges, steps and lists, and nothing else', () => {
    expect(parseCron('*/15 9-17 * * 1-5')).toMatchObject({ minutes: [0, 15, 30, 45], hours: [9, 10, 11, 12, 13, 14, 15, 16, 17], restrictsDayOfMonth: false, restrictsDayOfWeek: true });
    expect(parseCron('5,10,5 0 1 1 *').minutes).toEqual([5, 10]);
    expect(parseCron('10/20 * * * *').minutes).toEqual([10, 30, 50]);
    expect(parseCron('0-10/5 * * * *').minutes).toEqual([0, 5, 10]);
    // Sunday is 0, and 7 means the same day.
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]); expect([...parseCron('0 0 * * 0,7').daysOfWeek]).toEqual([0]);
    expect(parseCron('  0   12  *  *  *  ').hours).toEqual([12]);
    for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * 32 * *', '* * * 0 *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '* * * JAN *', '* * * * MON',
      '@daily', '1,,2 * * * *', '1- * * * *', '-1 * * * *', '1.5 * * * *', '* * * * *;', '0 0 31 2 *', '0 0 30,31 2 *', '0 0 31 4,6,9,11 *', `${'1,'.repeat(60)}1 * * * *`])
      expect([bad, (() => { try { parseCron(bad); return 'accepted'; } catch (error) { return error instanceof CronError ? 'refused' : 'crashed'; } })()]).toEqual([bad, 'refused']);
    // The 29th of February is a real date, and a weekday alternative makes an impossible date reachable.
    expect(() => parseCron('0 0 29 2 *')).not.toThrow(); expect(() => parseCron('0 0 31 2 1')).not.toThrow();
  });

  test('only time zones the runtime knows are accepted', () => {
    for (const zone of ['UTC', 'Europe/Brussels', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe']) expect([zone, validTimeZone(zone)]).toEqual([zone, true]);
    for (const zone of ['', 'Mars/Olympus', 'Europe/Brussels; DROP', '../etc', ' UTC', 'a'.repeat(80), '+02:00x']) expect([zone, validTimeZone(zone)]).toEqual([zone, false]);
    expect(() => nextCronTime(parseCron('* * * * *'), 'Mars/Olympus', new Date())).toThrow(CronError);
  });
});

describe('the next firing', () => {
  test('is strictly after the given instant, in the zone the schedule names', () => {
    expect(next('30 9 * * *', 'UTC', '2026-01-10T09:29:59Z')).toBe('2026-01-10T09:30:00.000Z');
    // Exactly on a firing: the next one, not the same one again.
    expect(next('30 9 * * *', 'UTC', '2026-01-10T09:30:00Z')).toBe('2026-01-11T09:30:00.000Z');
    expect(next('* * * * *', 'UTC', '2026-01-10T09:30:30Z')).toBe('2026-01-10T09:31:00.000Z');
    // 09:30 in Brussels is 08:30 UTC in winter and 07:30 UTC in summer.
    expect(next('30 9 * * *', 'Europe/Brussels', '2026-01-10T00:00:00Z')).toBe('2026-01-10T08:30:00.000Z');
    expect(next('30 9 * * *', 'Europe/Brussels', '2026-07-10T00:00:00Z')).toBe('2026-07-10T07:30:00.000Z');
    // A zone with a half-hour offset, and one on the far side of the date line from UTC.
    expect(next('0 0 * * *', 'Asia/Kolkata', '2026-01-10T00:00:00Z')).toBe('2026-01-10T18:30:00.000Z');
    expect(next('0 8 * * *', 'Pacific/Auckland', '2026-01-10T00:00:00Z')).toBe('2026-01-10T19:00:00.000Z');
  });

  test('months, days and weekdays combine as cron combines them', () => {
    // Weekdays only: Friday the 9th, then Monday the 12th.
    expect(firings('0 12 * * 1-5', 'UTC', '2026-01-09T00:00:00Z', '2026-01-13T00:00:00Z')).toEqual(['2026-01-09T12:00:00.000Z', '2026-01-12T12:00:00.000Z']);
    // The first of the month, across a year end.
    expect(firings('0 0 1 * *', 'UTC', '2026-11-15T00:00:00Z', '2027-02-02T00:00:00Z')).toEqual(['2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z']);
    // Both restricted: the 13th, or any Friday.
    expect(firings('0 0 13 * 5', 'UTC', '2026-01-08T00:00:00Z', '2026-01-17T00:00:00Z')).toEqual(['2026-01-09T00:00:00.000Z', '2026-01-13T00:00:00.000Z', '2026-01-16T00:00:00.000Z']);
    // The 31st skips the months that have none; the 29th of February waits for a leap year.
    expect(firings('0 0 31 * *', 'UTC', '2026-03-31T00:00:00Z', '2026-08-01T00:00:00Z')).toEqual(['2026-05-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z']);
    expect(next('0 0 29 2 *', 'UTC', '2026-03-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
    expect(next('0 0 * * 0', 'UTC', '2026-01-10T00:00:00Z')).toBe('2026-01-11T00:00:00.000Z');
  });

  test('a wall time that does not exist is skipped, and one that happens twice fires once', () => {
    // Brussels, 29 March 2026: 02:00 becomes 03:00. 02:30 does not happen that day.
    expect(firings('30 2 * * *', 'Europe/Brussels', '2026-03-27T12:00:00Z', '2026-03-31T12:00:00Z')).toEqual(['2026-03-28T01:30:00.000Z', '2026-03-30T00:30:00.000Z', '2026-03-31T00:30:00.000Z']);
    // The hour after the gap exists and fires at its real instant.
    expect(next('0 3 * * *', 'Europe/Brussels', '2026-03-28T12:00:00Z')).toBe('2026-03-29T01:00:00.000Z');
    // Brussels, 25 October 2026: 03:00 becomes 02:00. 02:30 happens twice; it fires at the first, 00:30 UTC, and not again an hour later.
    expect(firings('30 2 * * *', 'Europe/Brussels', '2026-10-24T12:00:00Z', '2026-10-26T12:00:00Z')).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z']);
    // Every minute of that repeated hour still fires once per wall minute: 60 firings between 02:00 and 03:00 wall time, not 120.
    expect(firings('* 2 * * *', 'Europe/Brussels', '2026-10-24T22:00:00Z', '2026-10-25T04:00:00Z')).toHaveLength(60);
    // An hourly schedule fires by wall hour: 24 times on the 25-hour day, and 23 times on the 23-hour day.
    expect(firings('0 * * * *', 'Europe/Brussels', '2026-10-24T21:59:59Z', '2026-10-25T23:00:00Z')).toHaveLength(24);
    expect(firings('0 * * * *', 'Europe/Brussels', '2026-03-28T22:59:59Z', '2026-03-29T22:00:00Z')).toHaveLength(23);
    // New York's change is on a different date and at a different instant.
    expect(firings('30 2 * * *', 'America/New_York', '2026-03-07T12:00:00Z', '2026-03-09T12:00:00Z')).toEqual(['2026-03-09T06:30:00.000Z']);
    // A zone that never changes its clocks is unaffected on those dates.
    expect(firings('30 2 * * *', 'UTC', '2026-03-28T12:00:00Z', '2026-03-30T12:00:00Z')).toEqual(['2026-03-29T02:30:00.000Z', '2026-03-30T02:30:00.000Z']);
  });

  test('successive firings never repeat and never go backwards', () => {
    for (const [expression, zone] of [['*/7 * * * *', 'Europe/Brussels'], ['15 */3 * * *', 'America/New_York'], ['0 0 * * 1', 'Australia/Lord_Howe']] as const) {
      const all = firings(expression, zone, '2026-03-01T00:00:00Z', '2026-04-10T00:00:00Z'); expect(all.length).toBeGreaterThan(5);
      for (let index = 1; index < all.length; index++) expect(all[index]! > all[index - 1]!).toBe(true);
    }
  });
});
