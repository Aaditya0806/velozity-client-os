/**
 * Shared validation primitives.
 *
 * Validation happens at the API boundary and again as a database constraint.
 * These schemas are the first line: they produce a good error message. The
 * constraints are the last line: they make the rule true.
 */
import { z } from 'zod';

export const uuid = z.string().uuid('Must be a valid identifier.');
export const optionalUuid = uuid.nullable().optional();

export const currencyCode = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'Must be a three-letter ISO 4217 currency code.');

export const countryCode = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, 'Must be a two-letter ISO 3166-1 country code.');

/**
 * Money as a decimal string. Never a number: JSON numbers are IEEE 754 doubles
 * and an invoice total is not something to round-trip through one.
 */
export const moneyAmount = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v.toFixed(2) : v.trim()))
  .refine((v) => /^-?\d{1,12}(\.\d{1,2})?$/.test(v), {
    message: 'Must be an amount with at most two decimal places.',
  });

export const positiveMoney = moneyAmount.refine((v) => Number.parseFloat(v) >= 0, {
  message: 'Must not be negative.',
});

export const percentage = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
  .refine((v) => /^\d{1,3}(\.\d{1,3})?$/.test(v) && Number.parseFloat(v) <= 100, {
    message: 'Must be a percentage between 0 and 100.',
  });

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD form.');

export const isoDateTime = z.string().datetime({ offset: true });

export const email = z.string().email('Must be a valid email address.').max(320);

export const shortText = (max = 200) => z.string().trim().min(1, 'Required.').max(max);
export const longText = (max = 20_000) => z.string().trim().max(max);
export const nullableText = (max = 20_000) => z.string().trim().max(max).nullable().optional();

export const tags = z.array(z.string().trim().min(1).max(50)).max(30).default([]);

/** A reason that is actually a reason, not a keystroke. */
export const meaningfulReason = z
  .string()
  .trim()
  .min(3, 'Please give a reason.')
  .max(2000);

export const overrideReason = z
  .string()
  .trim()
  .min(20, 'A legal override needs a written justification of at least 20 characters.')
  .max(2000);

// -----------------------------------------------------------------------------
// Listing
// -----------------------------------------------------------------------------

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

export const sortQuery = (columns: readonly string[], fallback: string) =>
  z.object({
    sort: z.enum(columns as [string, ...string[]]).default(fallback),
    direction: z.enum(['asc', 'desc']).default('desc'),
  });

export const searchQuery = z.object({
  q: z.string().trim().max(200).optional(),
});

export function listQuery<T extends z.ZodRawShape>(
  columns: readonly string[],
  fallback: string,
  extra?: T,
) {
  return paginationQuery
    .merge(sortQuery(columns, fallback))
    .merge(searchQuery)
    .merge(z.object(extra ?? ({} as T)));
}

export function paginationMeta(page: number, pageSize: number, total: number) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    page,
    page_size: pageSize,
    total,
    total_pages: totalPages,
    has_more: page < totalPages,
  };
}

/**
 * A sort column reaches SQL by concatenation, so it must come from a fixed list.
 * This helper makes that impossible to forget.
 */
export function safeOrderBy(
  column: string,
  direction: string,
  allowed: readonly string[],
  fallback: string,
): string {
  const col = allowed.includes(column) ? column : fallback;
  const dir = direction.toLowerCase() === 'asc' ? 'asc' : 'desc';
  return `"${col}" ${dir}`;
}

// -----------------------------------------------------------------------------
// Transitions
// -----------------------------------------------------------------------------

export const transitionBody = z.object({
  to: z.string().trim().min(1),
  reason: z.string().trim().max(2000).nullable().optional(),
  payload: z.record(z.unknown()).default({}),
});

export type TransitionBody = z.infer<typeof transitionBody>;
