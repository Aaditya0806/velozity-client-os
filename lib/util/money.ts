/**
 * Money arithmetic.
 *
 * Every monetary value in this system is a string-encoded decimal on the way in
 * and out of the database (numeric(14,2)) and a Decimal in between. There is no
 * code path where a currency amount becomes a JavaScript number, because
 * 0.1 + 0.2 is not 0.3 and an invoice is not the place to discover that.
 */
import { Decimal } from 'decimal.js';

Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP });

export type MoneyInput = string | number | Decimal | null | undefined;

export function money(value: MoneyInput): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  if (value instanceof Decimal) return value;
  return new Decimal(value);
}

/** Rounds to 2 decimal places, half-up, and renders as a plain string. */
export function toAmount(value: MoneyInput): string {
  return money(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function addAmounts(...values: MoneyInput[]): string {
  return toAmount(values.reduce<Decimal>((acc, v) => acc.plus(money(v)), new Decimal(0)));
}

export function multiplyAmount(amount: MoneyInput, factor: MoneyInput): string {
  return toAmount(money(amount).times(money(factor)));
}

export function percentOf(amount: MoneyInput, percent: MoneyInput): string {
  return toAmount(money(amount).times(money(percent)).dividedBy(100));
}

export function compareAmounts(a: MoneyInput, b: MoneyInput): -1 | 0 | 1 {
  return money(a).comparedTo(money(b)) as -1 | 0 | 1;
}

export function isZero(a: MoneyInput): boolean {
  return money(a).isZero();
}

/** Converts using an FX rate captured at transaction time. */
export function convert(amount: MoneyInput, rate: MoneyInput): string {
  return toAmount(money(amount).times(money(rate)));
}

const NO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']);

export function formatMoney(
  amount: MoneyInput,
  currency: string,
  locale = 'en-US',
  options: { compact?: boolean } = {},
): string {
  const digits = NO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
  const numeric = money(amount).toNumber();

  try {
    if (options.compact) {
      // The magnitude suffix is chosen here rather than by Intl's `notation:
      // 'compact'`, because Node and Chrome disagree about its case — Node
      // renders "US$38K", Chrome "US$38k". In a Client Component that is a
      // hydration mismatch, and it is invisible until React reports it.
      const abs = Math.abs(numeric);
      const [divisor, suffix] =
        abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : abs >= 1e3 ? [1e3, 'k'] : [1, ''];

      const scaled = numeric / divisor;
      const body = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        minimumFractionDigits: 0,
        // One decimal below 100 keeps "US$38.4k" informative; above that the
        // extra digit is noise.
        maximumFractionDigits: suffix && Math.abs(scaled) < 100 ? 1 : 0,
      }).format(scaled);

      return `${body}${suffix}`;
    }

    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(numeric);
  } catch {
    return `${currency} ${toAmount(amount)}`;
  }
}

export { Decimal };
