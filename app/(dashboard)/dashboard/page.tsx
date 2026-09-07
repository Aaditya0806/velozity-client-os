import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import {
  TrendingUp, Wallet, FolderKanban, CheckSquare, Scale, AlertTriangle, ArrowRight,
} from 'lucide-react';
import { requireContext, query } from '@/lib/auth/session';
import { getDashboard } from '@/lib/services/reporting';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonCards } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge, statusLabel } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatMoney, formatDate, formatNumber, daysUntil } from '@/lib/util/format';
import { PipelineFunnel } from '@/components/dashboard/pipeline-funnel';
import { DashboardHero } from '@/components/dashboard/hero';

export const metadata: Metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  return (
    <div className="space-y-6">
      <Suspense fallback={<SkeletonCards count={4} />}>
        <DashboardContent />
      </Suspense>
    </div>
  );
}

async function DashboardContent() {
  const ctx = await requireContext();
  const data = await query(ctx, (tx) => getDashboard(tx, ctx, {}), { readOnly: true });

  const base = ctx.org.baseCurrency;
  const canSeeFinance = data.revenue.permitted;
  const contracts = data.contracts;

  // The one thing most worth acting on, chosen by urgency rather than by
  // position in the object.
  const blocked = contracts.permitted ? contracts.blocked_onboardings.length : 0;
  const overdue = Number.parseInt(data.tasks.mine_overdue, 10);
  const awaiting = contracts.permitted ? contracts.awaiting_signature.length : 0;

  const headline =
    blocked > 0
      ? `${blocked} client${blocked === 1 ? '' : 's'} cannot start delivery until the paperwork is executed.`
      : overdue > 0
        ? `You have ${overdue} overdue task${overdue === 1 ? '' : 's'}.`
        : awaiting > 0
          ? `${awaiting} contract${awaiting === 1 ? ' is' : 's are'} waiting on a signature.`
          : 'Nothing needs your attention right now.';

  const action =
    blocked > 0
      ? { label: 'Review blocked onboarding', href: '/legal' }
      : overdue > 0
        ? { label: 'Open my tasks', href: '/tasks?scope=overdue' }
        : awaiting > 0
          ? { label: 'View contracts', href: '/legal?status=sent' }
          : { label: 'Open pipeline', href: '/pipeline' };

  return (
    <div className="space-y-6">
      <DashboardHero
        name={ctx.user.fullName || ctx.user.email}
        orgName={ctx.org.name}
        headline={headline}
        action={action}
      />

      <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Open pipeline"
          value={formatMoney(data.pipeline.open_total, base, 'en-GB', { compact: true })}
          hint={`${data.pipeline.open_count} open ${data.pipeline.open_count === 1 ? 'deal' : 'deals'}`}
          icon={TrendingUp}
          href="/pipeline"
        />
        <StatCard
          label="Won this period"
          value={formatMoney(data.pipeline.won_value, base, 'en-GB', { compact: true })}
          hint={
            data.pipeline.conversion_rate === null
              ? 'No closed deals yet'
              : `${data.pipeline.conversion_rate}% win rate`
          }
          icon={TrendingUp}
          tone="success"
        />
        {canSeeFinance ? (
          <StatCard
            label="Revenue received"
            value={formatMoney(data.revenue.received, base, 'en-GB', { compact: true })}
            hint={`${formatMoney(data.revenue.outstanding, base, 'en-GB', { compact: true })} outstanding`}
            icon={Wallet}
            href="/finance"
          />
        ) : (
          <StatCard
            label="Active projects"
            value={formatNumber(data.delivery.projects.active)}
            hint={`${data.delivery.projects.on_hold} on hold`}
            icon={FolderKanban}
            href="/projects"
          />
        )}
        <StatCard
          label="Your overdue tasks"
          value={formatNumber(data.tasks.mine_overdue)}
          hint={`${data.tasks.mine_open} open, ${data.tasks.mine_due_soon} due this week`}
          icon={CheckSquare}
          tone={overdue > 0 ? 'danger' : 'default'}
          href="/tasks?scope=overdue"
        />
      </div>

      {contracts.permitted && contracts.blocked_onboardings.length > 0 ? (
        <Card className="border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/[0.04]">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-[hsl(var(--warning))]">
              <AlertTriangle className="h-4 w-4" aria-hidden />
              Delivery blocked by outstanding paperwork
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {contracts.blocked_onboardings.slice(0, 5).map((item) => {
                const unmet = Array.isArray(item.blocked_reasons) ? item.blocked_reasons.length : 0;
                return (
                  <li key={item.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate font-medium">{item.company_name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {unmet} outstanding {unmet === 1 ? 'requirement' : 'requirements'}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="stagger grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Pipeline by stage</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link href="/pipeline">
                View pipeline
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {data.pipeline.by_stage.length === 0 ? (
              <EmptyState
                title="No open opportunities"
                description="Deals you create will appear here as they move through the funnel."
                action={
                  <Button asChild size="sm">
                    <Link href="/pipeline">Go to pipeline</Link>
                  </Button>
                }
              />
            ) : (
              <PipelineFunnel stages={data.pipeline.by_stage} currency={base} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Delivery health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <HealthRow label="Active projects" value={data.delivery.projects.active} />
            <HealthRow label="On hold" value={data.delivery.projects.on_hold} tone="warning" />
            <HealthRow label="At risk" value={data.delivery.projects.at_risk} tone="warning" />
            <HealthRow label="Off track" value={data.delivery.projects.off_track} tone="danger" />
            <div className="border-t pt-3">
              <HealthRow label="KPIs on track" value={data.delivery.kpis.on_track} tone="success" />
              <HealthRow label="KPIs at risk" value={data.delivery.kpis.at_risk} tone="warning" />
            </div>
          </CardContent>
        </Card>
      </div>

      {contracts.permitted ? (
        <div className="stagger grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Scale className="h-4 w-4 text-muted-foreground" aria-hidden />
                Awaiting signature
              </CardTitle>
              <Button asChild variant="ghost" size="sm">
                <Link href="/legal">
                  All contracts
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {contracts.awaiting_signature.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Nothing is waiting on a signature.
                </p>
              ) : (
                <ul className="divide-y">
                  {contracts.awaiting_signature.slice(0, 6).map((contract) => (
                    <li key={contract.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <Link
                          href={`/legal/contracts/${contract.id}`}
                          className="block truncate text-sm font-medium hover:underline"
                        >
                          {contract.reference}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">
                          {contract.company_name}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <StatusBadge status={contract.status} />
                        {Number.parseInt(contract.days_waiting, 10) > 7 ? (
                          <Badge variant="warning">{contract.days_waiting}d</Badge>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Renewals in the next 90 days</CardTitle>
            </CardHeader>
            <CardContent>
              {data.renewals.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No contracts expire in the next 90 days.
                </p>
              ) : (
                <ul className="divide-y">
                  {data.renewals.slice(0, 6).map((renewal) => {
                    const days = daysUntil(renewal.expiry_date);
                    return (
                      <li key={renewal.id} className="flex items-center justify-between gap-3 py-2.5">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{renewal.company_name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {renewal.reference} · {formatDate(renewal.expiry_date)}
                          </p>
                        </div>
                        <Badge variant={days !== null && days < 30 ? 'warning' : 'neutral'}>
                          {days} days
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {data.pipeline.lost_reasons.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Why deals were lost</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {data.pipeline.lost_reasons.map((reason) => (
                <Badge key={reason.lost_reason} variant="outline">
                  {statusLabel(reason.lost_reason)}
                  <span className="ml-1 text-muted-foreground">{reason.count}</span>
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function HealthRow({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}) {
  const count = Number.parseInt(value, 10);
  const colour =
    count === 0
      ? 'text-muted-foreground'
      : tone === 'success'
        ? 'text-[hsl(var(--success))]'
        : tone === 'warning'
          ? 'text-[hsl(var(--warning))]'
          : tone === 'danger'
            ? 'text-destructive'
            : '';

  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular font-medium ${colour}`}>{value}</span>
    </div>
  );
}
