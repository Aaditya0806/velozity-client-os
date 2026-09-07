import type { Metadata } from 'next';
import Link from 'next/link';
import { FolderKanban } from 'lucide-react';
import { requirePortalContext, portalQuery } from '@/lib/auth/portal';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDate } from '@/lib/util/format';

export const metadata: Metadata = { title: 'Projects' };
export const dynamic = 'force-dynamic';

interface ProjectRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  health: string | null;
  start_date: string | null;
  target_end_date: string | null;
  open_deliverables: string;
}

export default async function PortalProjectsPage() {
  const ctx = await requirePortalContext();

  const projects = await portalQuery(ctx, (tx) =>
    tx.many<ProjectRow>(
      `select p.id, p.code, p.name, p.description, p.status, p.health,
              p.start_date, p.target_end_date,
              (select count(*)::text
                 from portal.deliverables d
                where d.project_id = p.id
                  and d.status in ('delivered', 'in_review')) as open_deliverables
         from portal.projects p
        order by case when p.status in ('completed', 'cancelled') then 1 else 0 end,
                 p.start_date desc nulls last`,
    ),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything we are delivering for {ctx.company.name}.
        </p>
      </div>

      {projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="Once work begins, your projects and their milestones will appear here."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {projects.map((project) => (
            <Link key={project.id} href={`/portal/projects/${project.id}`} className="group">
              <Card className="h-full transition-shadow group-hover:shadow-md">
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-mono text-muted-foreground">{project.code}</p>
                      <h2 className="mt-0.5 truncate text-base font-semibold">{project.name}</h2>
                    </div>
                    <StatusBadge status={project.status} />
                  </div>

                  {project.description ? (
                    <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                      {project.description}
                    </p>
                  ) : null}

                  <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                    {project.start_date ? (
                      <div>
                        <dt className="inline">Started </dt>
                        <dd className="inline font-medium text-foreground">
                          {formatDate(project.start_date)}
                        </dd>
                      </div>
                    ) : null}
                    {project.target_end_date ? (
                      <div>
                        <dt className="inline">Target </dt>
                        <dd className="inline font-medium text-foreground">
                          {formatDate(project.target_end_date)}
                        </dd>
                      </div>
                    ) : null}
                  </dl>

                  {Number(project.open_deliverables) > 0 ? (
                    <p className="mt-3 text-xs font-medium text-[hsl(var(--warning))]">
                      {project.open_deliverables} awaiting your review
                    </p>
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
