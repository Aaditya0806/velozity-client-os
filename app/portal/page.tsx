import type { Metadata } from 'next';
import Link from 'next/link';
import { FolderKanban, FileText, Receipt, CheckCircle2, ArrowRight } from 'lucide-react';
import { requirePortalContext, portalQuery } from '@/lib/auth/portal';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDate } from '@/lib/util/format';
import { formatMoney } from '@/lib/util/money';

export const metadata: Metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

interface Overview {
  active_projects: number;
  open_deliverables: number;
  documents: number;
  outstanding: { currency: string; total: string } | null;
  recent: Array<{
    id: string;
    title: string;
    body: string | null;
    activity_type: string;
    occurred_at: string;
  }>;
  awaiting: Array<{
    id: string;
    name: string;
    project_name: string;
    due_date: string | null;
    status: string;
  }>;
}

export default async function PortalOverviewPage() {
  const ctx = await requirePortalContext();
  const canInvoices = ctx.company.capabilities.viewInvoices;

  const data = await portalQuery(ctx, async (tx): Promise<Overview> => {
    // Each of these reads a portal view. None can name a cost, a margin or
    // another client's row, because those columns are not in the projection.
    const [projects, deliverables, documents, outstanding, recent, awaiting] = await Promise.all([
      tx.one<{ n: string }>(
        `select count(*)::text as n from portal.projects where status not in ('completed', 'cancelled')`,
      ),
      tx.one<{ n: string }>(
        `select count(*)::text as n from portal.deliverables where status in ('delivered', 'in_review')`,
      ),
      ctx.company.capabilities.viewDocuments
        ? tx.one<{ n: string }>(`select count(*)::text as n from portal.documents`)
        : Promise.resolve({ n: '0' }),
      canInvoices
        ? tx.maybeOne<{ currency: string; total: string }>(
            `select currency, sum(balance_due)::text as total
               from portal.invoices
              where status <> 'paid' and balance_due > 0
              group by currency
              order by sum(balance_due) desc
              limit 1`,
          )
        : Promise.resolve(null),
      tx.many<Overview['recent'][number]>(
        `select id, title, body, activity_type, occurred_at
           from portal.activities
          order by occurred_at desc
          limit 8`,
      ),
      tx.many<Overview['awaiting'][number]>(
        `select d.id, d.name, p.name as project_name, d.due_date, d.status
           from portal.deliverables d
           join portal.projects p on p.id = d.project_id
          where d.status in ('delivered', 'in_review')
          order by d.due_date nulls last
          limit 5`,
      ),
    ]);

    return {
      active_projects: Number(projects.n),
      open_deliverables: Number(deliverables.n),
      documents: Number(documents.n),
      outstanding,
      recent,
      awaiting,
    };
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ctx.company.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything we are delivering for you, as your team sees it.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Active projects"
          value={String(data.active_projects)}
          icon={FolderKanban}
          href="/portal/projects"
        />
        <StatCard
          label="Awaiting your review"
          value={String(data.open_deliverables)}
          icon={CheckCircle2}
          tone={data.open_deliverables > 0 ? 'warning' : 'default'}
          hint={data.open_deliverables > 0 ? 'Deliverables need a decision' : 'Nothing outstanding'}
        />
        {ctx.company.capabilities.viewDocuments ? (
          <StatCard
            label="Documents"
            value={String(data.documents)}
            icon={FileText}
            href="/portal/documents"
          />
        ) : null}
        {canInvoices ? (
          <StatCard
            label="Outstanding"
            value={
              data.outstanding
                ? formatMoney(data.outstanding.total, data.outstanding.currency)
                : '—'
            }
            icon={Receipt}
            tone={data.outstanding ? 'warning' : 'default'}
            href="/portal/invoices"
            animate={false}
          />
        ) : null}
      </div>

      {data.awaiting.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Waiting on you</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {data.awaiting.map((item) => (
                <li key={item.id}>
                  <Link
                    href="/portal/projects"
                    className="flex items-center gap-3 px-5 py-3.5 text-sm hover:bg-accent/50"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{item.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {item.project_name}
                        {item.due_date ? ` · due ${formatDate(item.due_date)}` : ''}
                      </p>
                    </div>
                    <StatusBadge status={item.status} />
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          {data.recent.length === 0 ? (
            <EmptyState
              icon={FolderKanban}
              title="Nothing to show yet"
              description="Updates from your delivery team will appear here as work progresses."
            />
          ) : (
            <ol className="space-y-4">
              {data.recent.map((item) => (
                <li key={item.id} className="flex gap-3">
                  <span
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-500"
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{item.title}</p>
                    {item.body ? (
                      <p className="mt-0.5 text-sm text-muted-foreground">{item.body}</p>
                    ) : null}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatDate(item.occurred_at)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
