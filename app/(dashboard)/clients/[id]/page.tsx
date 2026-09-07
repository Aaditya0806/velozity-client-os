import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { requireContext, query } from '@/lib/auth/session';
import { getClientOverview } from '@/lib/services/client360';
import { isAppError } from '@/lib/http/errors';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { Badge } from '@/components/ui/badge';
import { ClientTabs } from './client-tabs';
import { formatDateTime } from '@/lib/util/format';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const ctx = await requireContext();
    const overview = await query(ctx, (tx) => getClientOverview(tx, ctx, id), { readOnly: true });
    return { title: String(overview.company.name) };
  } catch {
    return { title: 'Client' };
  }
}

export default async function ClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const ctx = await requireContext();

  let overview;
  try {
    overview = await query(ctx, (tx) => getClientOverview(tx, ctx, id), { readOnly: true });
  } catch (error) {
    // A row hidden by RLS and a row that does not exist are the same thing from
    // out here, and should look the same to the user.
    if (isAppError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const company = overview.company as Record<string, unknown>;

  return (
    <div className="space-y-6">
      <PageHeader
        title={String(company.name)}
        breadcrumbs={[
          { label: 'Clients', href: '/clients' },
          { label: String(company.name) },
        ]}
        meta={
          <>
            <StatusBadge status={String(company.lifecycle_stage)} />
            {company.health_status ? (
              <StatusBadge status={String(company.health_status)} />
            ) : null}
            {company.industry ? (
              <Badge variant="outline">{String(company.industry)}</Badge>
            ) : null}
            {company.parent_company_name ? (
              <Badge variant="neutral">
                Part of {String(company.parent_company_name)}
              </Badge>
            ) : null}
            {overview.group_company_ids.length > 1 ? (
              <Badge variant="info">
                {overview.group_company_ids.length} group entities
              </Badge>
            ) : null}
          </>
        }
      />

      {/*
        The permanent legal-override banner.

        It is rendered from the immutable legal_overrides table, not a dismissible
        flag, so it stays for the life of the client record. Delivery having once
        begun without executed paperwork is a fact worth keeping visible.
      */}
      {overview.legal_warnings.length > 0 ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/[0.06] p-4"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-destructive">
                Legal gate overridden
                {overview.legal_warnings.length > 1
                  ? ` (${overview.legal_warnings.length} times)`
                  : ''}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Delivery for this client began without all required executed documents.
              </p>
              <ul className="mt-3 space-y-2">
                {overview.legal_warnings.map((warning) => (
                  <li key={warning.id} className="text-sm">
                    <span className="text-muted-foreground">
                      {formatDateTime(warning.overridden_at, ctx.org.timezone)} ·{' '}
                      {warning.overridden_by_name}
                    </span>
                    <p className="mt-0.5">{warning.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : null}

      <ClientTabs
        clientId={id}
        initialTab={tab ?? 'overview'}
        overview={JSON.parse(JSON.stringify(overview))}
        permissions={ctx.permissions.toArray()}
        baseCurrency={ctx.org.baseCurrency}
        timezone={ctx.org.timezone}
      />
    </div>
  );
}
