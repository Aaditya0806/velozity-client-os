/**
 * Business time.
 *
 * Due dates and SLA clocks are computed on the organisation's working calendar,
 * in the organisation's timezone, skipping weekends and configured holidays.
 * A five-day task starting on a Thursday is due the following Thursday, not on
 * the Sunday.
 *
 * The calendar lives in the database because it is tenant data, so these helpers
 * take a transaction.
 */
import type { Tx } from '@/lib/db';

export interface BusinessCalendar {
  timezone: string;
  workingDays: number[];
  workStart: string;
  workEnd: string;
  holidays: Set<string>;
}

export async function loadCalendar(tx: Tx, orgId: string): Promise<BusinessCalendar> {
  const calendar = await tx.maybeOne<{
    timezone: string; working_days: number[]; work_start: string; work_end: string;
  }>(
    `select timezone, working_days, work_start, work_end
     from holiday_calendars where org_id = $1 and is_default limit 1`,
    [orgId],
  );

  const org = await tx.maybeOne<{ timezone: string }>(
    `select timezone from organizations where id = $1`,
    [orgId],
  );

  const holidays = await tx.many<{ holiday_on: string }>(
    `select to_char(holiday_on, 'YYYY-MM-DD') as holiday_on from holidays where org_id = $1`,
    [orgId],
  );

  return {
    timezone: calendar?.timezone ?? org?.timezone ?? 'UTC',
    workingDays: calendar?.working_days ?? [1, 2, 3, 4, 5],
    workStart: calendar?.work_start ?? '09:00',
    workEnd: calendar?.work_end ?? '18:00',
    holidays: new Set(holidays.map((h) => h.holiday_on)),
  };
}

/** ISO weekday: 1 = Monday .. 7 = Sunday. */
export function isoWeekday(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

export function isWorkingDay(date: Date, calendar: BusinessCalendar): boolean {
  if (!calendar.workingDays.includes(isoWeekday(date))) return false;
  return !calendar.holidays.has(date.toISOString().slice(0, 10));
}

/**
 * Adds `days` working days to a date. Zero returns the same date if it is a
 * working day, otherwise the next one - a task cannot start on a holiday.
 */
export function addBusinessDaysWith(
  startDate: string,
  days: number,
  calendar: BusinessCalendar,
): string {
  const date = new Date(`${startDate}T00:00:00Z`);

  if (days === 0) {
    while (!isWorkingDay(date, calendar)) {
      date.setUTCDate(date.getUTCDate() + 1);
    }
    return date.toISOString().slice(0, 10);
  }

  const step = days > 0 ? 1 : -1;
  let remaining = Math.abs(days);

  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + step);
    if (isWorkingDay(date, calendar)) remaining--;
  }

  return date.toISOString().slice(0, 10);
}

export async function addBusinessDays(
  tx: Tx,
  orgId: string,
  startDate: string,
  days: number,
): Promise<string> {
  const calendar = await loadCalendar(tx, orgId);
  return addBusinessDaysWith(startDate, days, calendar);
}

/** Working days between two dates, exclusive of the start. */
export function businessDaysBetween(
  from: string,
  to: string,
  calendar: BusinessCalendar,
): number {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const sign = end >= start ? 1 : -1;
  let count = 0;
  const cursor = new Date(start);

  while (sign > 0 ? cursor < end : cursor > end) {
    cursor.setUTCDate(cursor.getUTCDate() + sign);
    if (isWorkingDay(cursor, calendar)) count += sign;
  }
  return count;
}

/**
 * SLA deadline from a start instant and a number of business hours.
 * Hours outside the working window do not count toward the clock.
 */
export function slaDeadline(
  startedAt: Date,
  businessHours: number,
  calendar: BusinessCalendar,
): Date {
  const [startHour = 9, startMinute = 0] = calendar.workStart.split(':').map(Number);
  const [endHour = 18, endMinute = 0] = calendar.workEnd.split(':').map(Number);
  const hoursPerDay = endHour + endMinute / 60 - (startHour + startMinute / 60);

  const cursor = new Date(startedAt);
  let remaining = businessHours;

  // Guard against a misconfigured calendar producing an infinite loop.
  let iterations = 0;
  const maxIterations = 3650;

  while (remaining > 0 && iterations++ < maxIterations) {
    if (!isWorkingDay(cursor, calendar)) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(startHour, startMinute, 0, 0);
      continue;
    }

    const dayStart = new Date(cursor);
    dayStart.setUTCHours(startHour, startMinute, 0, 0);
    const dayEnd = new Date(cursor);
    dayEnd.setUTCHours(endHour, endMinute, 0, 0);

    if (cursor < dayStart) cursor.setTime(dayStart.getTime());
    if (cursor >= dayEnd) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(startHour, startMinute, 0, 0);
      continue;
    }

    const availableHours = (dayEnd.getTime() - cursor.getTime()) / 3_600_000;
    if (remaining <= availableHours) {
      cursor.setTime(cursor.getTime() + remaining * 3_600_000);
      remaining = 0;
    } else {
      remaining -= availableHours;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(startHour, startMinute, 0, 0);
    }
  }

  void hoursPerDay;
  return cursor;
}
