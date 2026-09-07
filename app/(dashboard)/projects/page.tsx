import type { Metadata } from 'next';
import { requireContext, query } from '@/lib/auth/session';
import { listProjects, projectListSchema } from '@/lib/services/projects';
import { PageHeader } from '@/components/layout/page-header';
import { ProjectsTable } from './projects-table';

export const metadata: Metadata = { title: 'Projects' };
export const dynamic = 'force-dynamic';

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireContext();
  const params = await searchParams;

  const parsed = projectListSchema.safeParse(params);
  const listQuery = parsed.success ? parsed.data : projectListSchema.parse({});

  const result = await query(ctx, (tx) => listProjects(tx, ctx, listQuery), { readOnly: true });

  return (
    <div className="space-y-6">
      <PageHeader title="Projects" description="Delivery in flight." />
      <ProjectsTable
        rows={JSON.parse(JSON.stringify(result.rows))}
        pagination={result.pagination}
      />
    </div>
  );
}
