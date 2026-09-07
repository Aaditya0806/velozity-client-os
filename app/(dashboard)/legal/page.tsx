import type { Metadata } from 'next';
import { requireContext, query } from '@/lib/auth/session';
import { listContracts, contractListSchema } from '@/lib/services/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { ContractsTable } from './contracts-table';

export const metadata: Metadata = { title: 'Legal' };
export const dynamic = 'force-dynamic';

export default async function LegalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireContext();
  const params = await searchParams;

  const parsed = contractListSchema.safeParse(params);
  const listQuery = parsed.success ? parsed.data : contractListSchema.parse({});

  const result = await query(ctx, (tx) => listContracts(tx, ctx, listQuery), {
    readOnly: true,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Legal"
        description="NDAs, agreements and everything awaiting a signature."
      />
      <ContractsTable
        rows={JSON.parse(JSON.stringify(result.rows))}
        pagination={result.pagination}
      />
    </div>
  );
}
