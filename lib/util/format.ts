/**
 * Display formatting.
 *
 * Kept in one place so a currency looks the same on the dashboard, in a table
 * and on a proposal, and so a date is never rendered by two different rules.
 */
import { formatMoney } from './money';

export { formatMoney };

export function formatDate(value: string | Date | null | undefined, locale = 'en-GB'): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(`${value.length === 10 ? `${value}T00:00:00Z` : value}`) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function formatDateTime(
  value: string | Date | null | undefined,
  timeZone = 'UTC',
  locale = 'en-GB',
): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(date);
}

/** "3 days ago", "in 2 weeks". Falls back to a date beyond a year. */
export function formatRelative(value: string | Date | null | undefined, locale = 'en-GB'): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';

  const diffMs = date.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 86_400_000],
    ['month', 30 * 86_400_000],
    ['week', 7 * 86_400_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];

  if (abs > 400 * 86_400_000) return formatDate(date, locale);

  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diffMs / ms), unit);
  }
  return 'just now';
}

export function formatNumber(value: string | number | null | undefined, locale = 'en-GB'): string {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = typeof value === 'number' ? value : Number.parseFloat(value);
  if (Number.isNaN(numeric)) return '—';
  return new Intl.NumberFormat(locale).format(numeric);
}

export function formatPercent(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = typeof value === 'number' ? value : Number.parseFloat(value);
  if (Number.isNaN(numeric)) return '—';
  return `${Math.round(numeric)}%`;
}

/** Days until a date; negative when already past. */
export function daysUntil(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const date = typeof value === 'string' ? new Date(`${value.length === 10 ? `${value}T00:00:00Z` : value}`) : value;
  if (Number.isNaN(date.getTime())) return null;
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}
