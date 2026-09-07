'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { FolderKanban } from 'lucide-react';
import { DataTable, type Column, type Pagination } from '@/components/ui/data-table';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDate } from '@/lib/util/format';

interface ProjectRow {
  id: string;
  code: string;
  name: string;
  status: string;
  health: string;
  company_name: string;
  manager_name: string | null;
  start_date: string | null;
  target_end_date: string | null;
  task_count: string;
  completed_task_count: string;
  overdue_task_count: string;
}

export function ProjectsTable({
  rows,
  pagination,
}: {
  rows: ProjectRow[];
  pagination: Pagination;
}) {
  const router = useRouter();

  const columns: Column<ProjectRow>[] = [
    {
      key: 'name',
      header: 'Project',
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <Link
            href={`/projects/${row.id}`}
            className="block truncate font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.name}
          </Link>
          <p className="truncate text-xs text-muted-foreground">
            {row.code} · {row.company_name}
          </p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', sortable: true, render: (row) => <StatusBadge status={row.status} /> },
    { key: 'health', header: 'Health', sortable: true, render: (row) => <StatusBadge status={row.health} /> },
    {
      key: 'progress',
      header: 'Progress',
      align: 'right',
      render: (row) => {
        const total = Number.parseInt(row.task_count, 10);
        const done = Number.parseInt(row.completed_task_count, 10);
        if (total === 0) return <span className="text-muted-foreground">—</span>;
        return (
          <span title={`${done} of ${total} tasks complete`}>
            {Math.round((done / total) * 100)}%
          </span>
        );
      },
    },
    {
      key: 'overdue_task_count',
      header: 'Overdue',
      align: 'right',
      render: (row) => {
        const overdue = Number.parseInt(row.overdue_task_count, 10);
        return overdue > 0 ? (
          <span className="font-medium text-destructive">{overdue}</span>
        ) : (
          <span className="text-muted-foreground">0</span>
        );
      },
    },
    {
      key: 'manager_name',
      header: 'Manager',
      optional: true,
      render: (row) => row.manager_name ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'target_end_date',
      header: 'Target end',
      sortable: true,
      render: (row) => formatDate(row.target_end_date),
    },
  ];

  return (
    <DataTable
      rows={rows}
      columns={columns}
      pagination={pagination}
      searchPlaceholder="Search projects…"
      emptyIcon={FolderKanban}
      emptyTitle="No projects"
      emptyDescription="A project is created once onboarding for a won deal completes."
      onRowClick={(row) => router.push(`/projects/${row.id}`)}
    />
  );
}
