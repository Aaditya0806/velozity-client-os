import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requirePortalContext, portalQuery } from '@/lib/auth/portal';
import { Card, CardContent } from '@/components/ui/card';
import { AcknowledgeReport } from '@/components/portal/acknowledge-report';
import { formatDate } from '@/lib/util/format';

export const metadata: Metadata = { title: 'Report' };
export const dynamic = 'force-dynamic';

interface Report {
  id: string;
  title: string;
  summary: string | null;
  content: string | null;
  period_start: string;
  period_end: string;
  published_at: string | null;
  acknowledged_at: string | null;
}

export default async function PortalReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requirePortalContext();

  const report = await portalQuery(ctx, (tx) =>
    tx.maybeOne<Report>(
      `select r.id, r.title, r.summary, r.content, r.period_start, r.period_end,
              r.published_at, rr.acknowledged_at
         from portal.reports r
         left join portal.report_receipts rr on rr.report_id = r.id
        where r.id = $1`,
      [id],
    ),
  );

  if (!report) notFound();

  return (
    <div className="space-y-6">
      <Link
        href="/portal/reports"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All reports
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{report.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDate(report.period_start)} – {formatDate(report.period_end)}
            {report.published_at ? ` · published ${formatDate(report.published_at)}` : ''}
          </p>
        </div>
        <AcknowledgeReport reportId={report.id} acknowledgedAt={report.acknowledged_at} />
      </div>

      {report.summary ? (
        <Card>
          <CardContent className="p-5">
            <p className="text-sm font-medium">Summary</p>
            <p className="mt-1.5 whitespace-pre-wrap text-sm text-muted-foreground">
              {report.summary}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {report.content ? (
        <Card>
          <CardContent className="p-6">
            {/*
              Rendered as text, not HTML. Report content is written by the team
              in the internal application, but "written by someone we trust" is
              not the same as "safe to inject into a client's browser".
            */}
            <div className="whitespace-pre-wrap text-sm leading-relaxed">{report.content}</div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
