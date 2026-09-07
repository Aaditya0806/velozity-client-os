/**
 * The audit log.
 *
 * Separate from domain events on purpose. Events describe what happened for the
 * benefit of the product (timelines, automations, notifications). The audit log
 * exists for the benefit of an auditor: it is append-only at the privilege
 * level, it records the actor, the before and after state, the reason and the
 * request, and nothing in the application can amend it.
 *
 * Audit writes join the caller's transaction. If the business change rolls back,
 * so does its audit record - a log of things that did not happen is worse than
 * no log.
 */
import type { Tx } from '@/lib/db';

export type AuditCategory =
  | 'auth'
  | 'permission'
  | 'state_change'
  | 'contract'
  | 'proposal'
  | 'document'
  | 'payment'
  | 'ai'
  | 'automation'
  | 'legal_override'
  | 'user_admin'
  | 'admin'
  | 'security'
  | 'data_access';

export type AuditSeverity = 'info' | 'notice' | 'warning' | 'critical';
export type ActorType = 'user' | 'system' | 'automation' | 'provider' | 'ai';

export interface AuditEntry {
  orgId: string | null;
  action: string;
  category: AuditCategory;
  severity?: AuditSeverity;
  actorUserId?: string | null;
  actorType?: ActorType;
  actorLabel?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export async function writeAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.query(
    `insert into audit_log (
       org_id, action, category, severity, actor_user_id, actor_type, actor_label,
       entity_type, entity_id, summary, before_state, after_state, metadata,
       reason, ip_address, user_agent, request_id
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      entry.orgId,
      entry.action,
      entry.category,
      entry.severity ?? 'info',
      entry.actorUserId ?? null,
      entry.actorType ?? 'user',
      entry.actorLabel ?? null,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.summary,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      JSON.stringify(entry.metadata ?? {}),
      entry.reason ?? null,
      entry.ipAddress ?? null,
      entry.userAgent ?? null,
      entry.requestId ?? tx.context.requestId ?? null,
    ],
  );
}

/**
 * Records only the columns that actually changed, so a diff is readable rather
 * than a wall of unchanged fields.
 */
export function diffRows(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  ignore: readonly string[] = ['updated_at'],
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);

  for (const key of keys) {
    if (ignore.includes(key)) continue;
    const bv = before?.[key];
    const av = after?.[key];
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      b[key] = bv ?? null;
      a[key] = av ?? null;
    }
  }
  return { before: b, after: a };
}
