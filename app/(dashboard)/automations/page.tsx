import type { Metadata } from 'next';
import { Workflow, ShieldCheck } from 'lucide-react';
import { requireContext, query } from '@/lib/auth/session';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { formatRelative } from '@/lib/util/format';
import {
  NewAutomationButton,
  AutomationRowControls,
  type AutomationSummary,
} from './automation-controls';

export const metadata: Metadata = { title: 'Automations' };
export const dynamic = 'force-dynamic';

export default async function AutomationsPage() {
  const ctx = await requireContext();

  const canManage = ctx.permissions.has('automation:manage:org');

  const { automations, runs, users } = await query(
    ctx,
    async (tx) => ({
      automations: await tx.many<Record<string, unknown>>(
        `select a.*, jsonb_array_length(a.actions) as action_count
         from automations a
         where a.deleted_at is null
         order by a.is_active desc, a.name`,
      ),
      runs: await tx.many<Record<string, unknown>>(
        `select r.id, r.status, r.created_at, r.duration_ms, r.depth,
                a.name as automation_name, r.entity_type
         from automation_runs r
         join automations a on a.id = r.automation_id
         order by r.created_at desc
         limit 25`,
      ),
      // For the "assign an owner" action, which needs real people to choose
      // between rather than a free-text user id.
      users: await tx.many<{ id: string; full_name: string }>(
        `select u.id, u.full_name
           from user_profiles u
           join org_memberships m on m.user_id = u.id
          where m.org_id = $1 and m.status = 'active' and u.deleted_at is null
          order by u.full_name`,
        [ctx.org.id],
      ),
    }),
    { readOnly: true },
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Automations"
        description="When something happens, if a condition holds, then do these things."
        actions={canManage ? <NewAutomationButton users={users} /> : undefined}
      />

      <Card className="border-primary/30 bg-primary/[0.03]">
        <CardContent className="flex items-start gap-3 p-4">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <div className="text-sm">
            <p className="font-medium">Automations prepare work. They do not commit to anything.</p>
            <p className="mt-1 text-muted-foreground">
              An automation can draft an email, produce a contract draft, create a task or
              notify someone. It cannot send an email, send a contract for signature, or move
              anything through its lifecycle — those need a person with the relevant authority.
            </p>
          </div>
        </CardContent>
      </Card>

      {automations.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No automations"
          description="An automation reacts to an event, checks conditions against a snapshot, then runs a fixed set of actions."
        />
      ) : (
        <div className="space-y-3">
          {automations.map((automation) => {
            const actions = Array.isArray(automation.actions)
              ? (automation.actions as Array<{ type: string }>)
              : [];
            const conditions = Array.isArray(automation.conditions)
              ? (automation.conditions as Array<{ path: string; op: string; value: unknown }>)
              : [];
            const filter = automation.trigger_filter as Record<string, unknown>;

            return (
              <Card key={String(automation.id)} data-automation={String(automation.name)}>
                <CardContent className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{String(automation.name)}</p>
                      {automation.description ? (
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {String(automation.description)}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant={automation.is_active ? 'success' : 'neutral'}>
                        {automation.is_active ? 'Active' : 'Paused'}
                      </Badge>
                      {Number(automation.run_count) > 0 ? (
                        <span className="text-xs text-muted-foreground">
                          {String(automation.run_count)} runs
                        </span>
                      ) : null}
                      {canManage ? (
                        <AutomationRowControls
                          automation={
                            JSON.parse(JSON.stringify(automation)) as AutomationSummary
                          }
                          users={users}
                        />
                      ) : null}
                    </div>
                  </div>

                  <dl className="mt-4 space-y-2 text-sm">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <dt className="w-16 shrink-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                        When
                      </dt>
                      <dd className="flex flex-wrap gap-1.5">
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                          {String(automation.trigger_event)}
                        </code>
                        {Object.entries(filter ?? {}).map(([key, value]) => (
                          <Badge key={key} variant="outline">
                            {key} = {String(value)}
                          </Badge>
                        ))}
                      </dd>
                    </div>

                    {conditions.length > 0 ? (
                      <div className="flex flex-wrap items-baseline gap-2">
                        <dt className="w-16 shrink-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                          If
                        </dt>
                        <dd className="flex flex-wrap gap-1.5">
                          {conditions.map((condition, index) => (
                            <Badge key={index} variant="outline">
                              {condition.path} {condition.op} {String(condition.value ?? '')}
                            </Badge>
                          ))}
                        </dd>
                      </div>
                    ) : null}

                    <div className="flex flex-wrap items-baseline gap-2">
                      <dt className="w-16 shrink-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Then
                      </dt>
                      <dd className="flex flex-wrap gap-1.5">
                        {actions.map((action, index) => (
                          <Badge key={index} variant="info">
                            {action.type.replace(/_/g, ' ')}
                          </Badge>
                        ))}
                      </dd>
                    </div>
                  </dl>

                  <p className="mt-3 text-xs text-muted-foreground">
                    Max chain depth {String(automation.max_depth)} · cooldown{' '}
                    {String(automation.cooldown_seconds)}s per entity
                    {automation.last_run_at
                      ? ` · last ran ${formatRelative(automation.last_run_at as string)}`
                      : ''}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No automation has run yet.</p>
          ) : (
            <ul className="divide-y">
              {runs.map((run) => (
                <li key={String(run.id)} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{String(run.automation_name)}</p>
                    <p className="text-xs text-muted-foreground">
                      {String(run.entity_type)} · {formatRelative(run.created_at as string)}
                      {run.duration_ms ? ` · ${String(run.duration_ms)}ms` : ''}
                      {Number(run.depth) > 0 ? ` · depth ${String(run.depth)}` : ''}
                    </p>
                  </div>
                  <RunStatus status={String(run.status)} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * A suppressed run is shown as suppressed, not hidden. Loop protection that
 * operates invisibly is indistinguishable from a broken automation.
 */
function RunStatus({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: 'success' | 'warning' | 'danger' | 'neutral' }> = {
    succeeded: { label: 'Succeeded', variant: 'success' },
    partially_failed: { label: 'Partly failed', variant: 'warning' },
    failed: { label: 'Failed', variant: 'danger' },
    conditions_failed: { label: 'Conditions not met', variant: 'neutral' },
    skipped_cooldown: { label: 'Suppressed: cooldown', variant: 'neutral' },
    skipped_depth: { label: 'Suppressed: chain depth', variant: 'warning' },
    running: { label: 'Running', variant: 'neutral' },
    pending: { label: 'Pending', variant: 'neutral' },
  };
  const entry = map[status] ?? { label: status, variant: 'neutral' as const };
  return <Badge variant={entry.variant}>{entry.label}</Badge>;
}

