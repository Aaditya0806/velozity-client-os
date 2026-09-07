import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CheckCircle2, Target } from 'lucide-react';
import { requirePortalContext, portalQuery } from '@/lib/auth/portal';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { DeliverableDecision } from '@/components/portal/deliverable-decision';
import { formatDate, formatNumber } from '@/lib/util/format';

export const metadata: Metadata = { title: 'Project' };
export const dynamic = 'force-dynamic';

interface Project {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  health: string | null;
  start_date: string | null;
  target_end_date: string | null;
  actual_end_date: string | null;
}

interface Deliverable {
  id: string;
  name: string;
  description: string | null;
  status: string;
  due_date: string | null;
  delivered_at: string | null;
  accepted_at: string | null;
  rejection_reason: string | null;
}

interface Milestone {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  completed_at: string | null;
  is_milestone: boolean;
}

interface Kpi {
  id: string;
  name: string;
  unit: string | null;
  direction: string | null;
  target_value: string | null;
  current_value: string | null;
  status: string | null;
}

export default async function PortalProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requirePortalContext();
  const canApprove = ctx.company.capabilities.approveDeliverables;

  const data = await portalQuery(ctx, async (tx) => {
    // The view is the boundary: a project belonging to another client simply is
    // not in it, so this returns nothing rather than refusing.
    const project = await tx.maybeOne<Project>(
      `select id, code, name, description, status, health,
              start_date, target_end_date, actual_end_date
         from portal.projects where id = $1`,
      [id],
    );
    if (!project) return null;

    const [deliverables, milestones, kpis] = await Promise.all([
      tx.many<Deliverable>(
        `select d.id, d.name, d.description, d.status, d.due_date, d.delivered_at,
                dd.accepted_at, dd.rejection_reason
           from portal.deliverables d
           left join portal.deliverable_decisions dd on dd.id = d.id
          where d.project_id = $1
          order by d.due_date nulls last`,
        [id],
      ),
      tx.many<Milestone>(
        `select id, title, status, due_date, completed_at, is_milestone
           from portal.tasks
          where project_id = $1 and is_milestone
          order by due_date nulls last`,
        [id],
      ),
      tx.many<Kpi>(
        `select id, name, unit, direction, target_value, current_value, status
           from portal.kpis
          where project_id = $1`,
        [id],
      ),
    ]);

    return { project, deliverables, milestones, kpis };
  });

  if (!data) notFound();
  const { project, deliverables, milestones, kpis } = data;

  return (
    <div className="space-y-6">
      <Link
        href="/portal/projects"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All projects
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted-foreground">{project.code}</p>
          <h1 className="mt-0.5 text-2xl font-semibold tracking-tight">{project.name}</h1>
          {project.description ? (
            <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{project.description}</p>
          ) : null}
        </div>
        <StatusBadge status={project.status} />
      </div>

      <Card>
        <CardContent className="grid gap-4 p-5 sm:grid-cols-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Started</p>
            <p className="mt-1 text-sm font-medium">{formatDate(project.start_date) || '—'}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Target</p>
            <p className="mt-1 text-sm font-medium">{formatDate(project.target_end_date) || '—'}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Completed</p>
            <p className="mt-1 text-sm font-medium">{formatDate(project.actual_end_date) || '—'}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Deliverables</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {deliverables.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={CheckCircle2}
                title="No deliverables yet"
                description="Work items shared with you will appear here as they are produced."
              />
            </div>
          ) : (
            <ul className="divide-y">
              {deliverables.map((item) => {
                const awaiting = item.status === 'delivered' || item.status === 'in_review';
                return (
                  <li key={item.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{item.name}</p>
                      {item.description ? (
                        <p className="mt-0.5 text-sm text-muted-foreground">{item.description}</p>
                      ) : null}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.due_date ? `Due ${formatDate(item.due_date)}` : 'No due date'}
                        {item.delivered_at ? ` · delivered ${formatDate(item.delivered_at)}` : ''}
                        {item.accepted_at ? ` · accepted ${formatDate(item.accepted_at)}` : ''}
                      </p>
                      {item.rejection_reason ? (
                        <p className="mt-1.5 rounded-lg bg-muted p-2 text-xs">
                          <span className="font-medium">Your feedback: </span>
                          {item.rejection_reason}
                        </p>
                      ) : null}
                    </div>

                    <StatusBadge status={item.status} />

                    {awaiting && canApprove ? (
                      <DeliverableDecision deliverableId={item.id} name={item.name} />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {milestones.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Milestones</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {milestones.map((item) => (
                <li key={item.id} className="flex items-center gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.completed_at
                        ? `Completed ${formatDate(item.completed_at)}`
                        : item.due_date
                          ? `Due ${formatDate(item.due_date)}`
                          : 'No date set'}
                    </p>
                  </div>
                  <StatusBadge status={item.status} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {kpis.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Measures</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {kpis.map((kpi) => (
              <div key={kpi.id} className="rounded-xl border p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium">{kpi.name}</p>
                  <Target className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </div>
                <p className="tabular mt-2 text-xl font-semibold">
                  {kpi.current_value !== null ? formatNumber(kpi.current_value) : '—'}
                  {kpi.unit ? <span className="ml-1 text-sm font-normal">{kpi.unit}</span> : null}
                </p>
                {kpi.target_value !== null ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Target {formatNumber(kpi.target_value)}
                    {kpi.unit ? ` ${kpi.unit}` : ''}
                  </p>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
