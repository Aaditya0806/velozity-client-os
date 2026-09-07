import type { Metadata } from 'next';
import { requireContext, query } from '@/lib/auth/session';
import { listTasks, taskListSchema } from '@/lib/services/projects';
import { PageHeader } from '@/components/layout/page-header';
import { TasksView } from './tasks-view';

export const metadata: Metadata = { title: 'Tasks' };
export const dynamic = 'force-dynamic';

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireContext();
  const params = await searchParams;

  const parsed = taskListSchema.safeParse({ scope: 'mine', ...params });
  const listQuery = parsed.success ? parsed.data : taskListSchema.parse({ scope: 'mine' });

  const result = await query(ctx, (tx) => listTasks(tx, ctx, listQuery), { readOnly: true });

  return (
    <div className="space-y-6">
      <PageHeader title="Tasks" description="What needs doing, and by when." />
      <TasksView
        rows={JSON.parse(JSON.stringify(result.rows))}
        pagination={result.pagination}
        scope={listQuery.scope ?? 'mine'}
      />
    </div>
  );
}
