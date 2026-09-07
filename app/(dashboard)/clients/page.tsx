import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireContext, query } from '@/lib/auth/session';
import { listCompanies, companyListSchema } from '@/lib/services/companies';
import { PageHeader } from '@/components/layout/page-header';
import { SkeletonTable } from '@/components/ui/skeleton';
import { ClientsTable } from './clients-table';
import { NewClientButton } from './new-client-button';

export const metadata: Metadata = { title: 'Clients' };
export const dynamic = 'force-dynamic';

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireContext();
  const params = await searchParams;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Clients"
        description="Every company you sell to and deliver for."
        actions={ctx.permissions.has('company:create:org') ? <NewClientButton /> : null}
      />
      <Suspense fallback={<SkeletonTable columns={6} />}>
        <ClientsContent params={params} />
      </Suspense>
    </div>
  );
}

async function ClientsContent({
  params,
}: {
  params: Record<string, string | string[] | undefined>;
}) {
  const ctx = await requireContext();

  // Unparseable query strings fall back to defaults rather than erroring: a
  // stale bookmark should show the list, not a stack trace.
  const parsed = companyListSchema.safeParse(params);
  const listQuery = parsed.success ? parsed.data : companyListSchema.parse({});

  const result = await query(ctx, (tx) => listCompanies(tx, ctx, listQuery), {
    readOnly: true,
  });

  return (
    <ClientsTable
      rows={result.rows as never[]}
      pagination={result.pagination}
      canCreate={ctx.permissions.has('company:create:org')}
    />
  );
}

