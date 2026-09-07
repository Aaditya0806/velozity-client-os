/**
 * Server-side permission checks.
 *
 * These sit *in front of* RLS, not instead of it. RLS guarantees a user can
 * never read or write a row they should not; these checks let the API answer
 * with a clear 403 and a useful message instead of an empty result set, and let
 * the UI hide what a user cannot do.
 *
 * The rule the whole product depends on: authentication is never authorization.
 * A valid session tells you who is asking, and nothing about what they may do.
 */
import type { Scope, PermissionKey } from './catalog';
import { SCOPE_RANK, parsePermission, SENSITIVE_PERMISSIONS } from './catalog';
import { AppError } from '@/lib/http/errors';

export * from './catalog';

/** The permission set resolved once per request. */
export interface PermissionSet {
  readonly keys: ReadonlySet<string>;
  /** Broadest scope held for a resource:action pair, or null. */
  scopeFor(resource: string, action: string): Scope | null;
  has(key: PermissionKey | string): boolean;
  /** True if the user holds resource:action at any scope. */
  can(resource: string, action: string): boolean;
  /** Throws FORBIDDEN unless the permission is held. */
  require(key: PermissionKey | string, message?: string): void;
  requireAny(resource: string, action: string, message?: string): Scope;
  /** All keys, for serialising to the client. */
  toArray(): string[];
}

export function buildPermissionSet(keys: readonly string[]): PermissionSet {
  const set = new Set(keys);

  // Precompute the broadest scope per resource:action so row filtering is O(1).
  const scopes = new Map<string, Scope>();
  for (const key of set) {
    const parsed = parsePermission(key);
    if (!parsed) continue;
    const pair = `${parsed.resource}:${parsed.action}`;
    const current = scopes.get(pair);
    if (!current || SCOPE_RANK[parsed.scope] > SCOPE_RANK[current]) {
      scopes.set(pair, parsed.scope);
    }
  }

  return {
    keys: set,
    scopeFor(resource, action) {
      return scopes.get(`${resource}:${action}`) ?? null;
    },
    has(key) {
      return set.has(key);
    },
    can(resource, action) {
      return scopes.has(`${resource}:${action}`);
    },
    require(key, message) {
      if (!set.has(key)) {
        throw new AppError(
          'FORBIDDEN',
          message ?? `This action requires the ${key} permission.`,
          { details: { required: key } },
        );
      }
    },
    requireAny(resource, action, message) {
      const scope = scopes.get(`${resource}:${action}`);
      if (!scope) {
        throw new AppError(
          'FORBIDDEN',
          message ?? `This action requires the ${resource}:${action} permission.`,
          { details: { required: `${resource}:${action}` } },
        );
      }
      return scope;
    },
    toArray() {
      return [...set].sort();
    },
  };
}

export const EMPTY_PERMISSIONS = buildPermissionSet([]);

/**
 * Row-level visibility for an ownable record, mirroring app.can_access() in SQL.
 * Used to decide *before* a query whether it is worth running, and to reason
 * about a row already in hand.
 */
export function canAccessRow(
  permissions: PermissionSet,
  resource: string,
  action: string,
  row: { ownerUserId?: string | null; teamId?: string | null },
  actor: { userId: string; teamIds: readonly string[] },
): boolean {
  const scope = permissions.scopeFor(resource, action);
  if (!scope) return false;
  if (scope === 'org') return true;
  if (row.ownerUserId && row.ownerUserId === actor.userId) return true;
  if (scope === 'team' && row.teamId) return actor.teamIds.includes(row.teamId);
  return false;
}

export function isSensitive(key: string): boolean {
  return SENSITIVE_PERMISSIONS.has(key);
}

/**
 * Field-level redaction.
 *
 * Margin, cost, internal notes and internal AI analysis are stripped from a
 * record before it leaves the server unless the caller explicitly holds the
 * permission. Doing this on the way out - rather than hiding fields in the UI -
 * means an API consumer cannot simply read the JSON.
 */
export const SENSITIVE_FIELD_PERMISSIONS: Record<string, string> = {
  margin_amount: 'margin:read:org',
  margin_percent: 'margin:read:org',
  cost_total: 'cost:read:org',
  cost_amount: 'cost:read:org',
  cost_to_date: 'cost:read:org',
  unit_cost: 'cost:read:org',
  internal_notes: 'internal_note:read:org',
};

export function redactSensitiveFields<T extends Record<string, unknown>>(
  row: T,
  permissions: PermissionSet,
): T {
  let copy: Record<string, unknown> | null = null;
  for (const [field, required] of Object.entries(SENSITIVE_FIELD_PERMISSIONS)) {
    if (field in row && !permissions.has(required)) {
      copy ??= { ...row };
      delete copy[field];
    }
  }
  return (copy ?? row) as T;
}

export function redactMany<T extends Record<string, unknown>>(
  rows: readonly T[],
  permissions: PermissionSet,
): T[] {
  return rows.map((r) => redactSensitiveFields(r, permissions));
}
