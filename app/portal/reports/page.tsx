import type { Metadata } from 'next';
import Link from 'next/link';
import { BarChart3, Check } from 'lucide-react';
import { requirePortalContext, portalQuery } from '@/lib/auth/portal';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate } from '@/lib/util/format';

export const metadata: Metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

interface ReportRow {
  id: string;
  title: string;
  summary: string | null;
  period_start: string;
  period_end: string;
  published_at: string | null;
  acknowledged_at: string | null;
}

export default async function PortalReportsPage() {
  const ctx = await requirePortalContext();

  const reports = await portalQuery(ctx, (tx) =>
    tx.many<ReportRow>(
      `select r.id, r.title, r.summary, r.period_start, r.period_end, r.published_at,
              rr.acknowledged_at
         from portal.reports r
         left join portal.report_receipts rr on rr.report_id = r.id
        order by r.period_end desc`,
    ),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Progress reports published for {ctx.company.name}.
        </p>
      </div>

      {reports.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No reports yet"
          description="Published progress reports will appear here."
        />
      ) : (
        <div className="space-y-3">
          {reports.map((report) => (
            <Link key={report.id} href={`/portal/reports/${report.id}`} className="block">
              <Card className="transition-shadow hover:shadow-md">
                <CardContent className="flex items-start gap-4 p-5">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate font-semibold">{report.title}</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatDate(report.period_start)} – {formatDate(report.period_end)}
                      {report.published_at ? ` · published ${formatDate(report.published_at)}` : ''}
                    </p>
                    {report.summary ? (
                      <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                        {report.summary}
                      </p>
                    ) : null}
                  </div>
                  {report.acknowledged_at ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-[hsl(var(--success))]">
                      <Check className="h-3.5 w-3.5" aria-hidden />
                      Read
                    </span>
                  ) : null}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
