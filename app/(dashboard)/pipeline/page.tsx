import type { Metadata } from 'next';
import { requireContext, query } from '@/lib/auth/session';
import { listOpportunities, OPEN_STAGES } from '@/lib/services/opportunities';
import { PageHeader } from '@/components/layout/page-header';
import { PipelineBoard } from './pipeline-board';
import { NewOpportunityButton } from './new-opportunity-button';

export const metadata: Metadata = { title: 'Pipeline' };
export const dynamic = 'force-dynamic';

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ owner?: string; view?: string }>;
}) {
  const ctx = await requireContext();
  const params = await searchParams;

  // The board loads every open deal at once, which is the right trade for a
  // pipeline: a Kanban that pages is not a pipeline. The page size is capped so
  // an unusually large tenant degrades into a truncated board with a notice
  // rather than an unbounded query.
  const result = await query(
    ctx,
    (tx) =>
      listOpportunities(tx, ctx, {
        page: 1,
        page_size: 100,
        sort: 'updated_at',
        direction: 'desc',
        open_only: 'true',
        ...(params.owner ? { owner_user_id: params.owner } : {}),
      } as Parameters<typeof listOpportunities>[2]),
    { readOnly: true },
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pipeline"
        description="Every open deal, by stage."
        actions={
          ctx.permissions.has('opportunity:create:org') ? <NewOpportunityButton /> : null
        }
      />

      <PipelineBoard
        opportunities={JSON.parse(JSON.stringify(result.rows))}
        stages={[...OPEN_STAGES]}
        total={result.pagination.total}
        truncated={result.pagination.total > result.rows.length}
        baseCurrency={ctx.org.baseCurrency}
        canTransition={ctx.permissions.can('opportunity', 'update')}
      />
    </div>
  );
}
