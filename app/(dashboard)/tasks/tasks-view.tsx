'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { CheckSquare, Check } from 'lucide-react';
import { DataTable, type Column, type Pagination } from '@/components/ui/data-table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { formatDate } from '@/lib/util/format';

interface TaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  is_overdue: boolean;
  assignee_name: string | null;
  project_name: string | null;
  project_code: string | null;
  company_name: string | null;
  subtask_count: string;
}

const SCOPES = [
  { key: 'mine', label: 'My tasks' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'due_soon', label: 'Due soon' },
  { key: 'team', label: 'My team' },
  { key: 'all', label: 'All' },
  { key: 'completed', label: 'Completed' },
];

const PRIORITY_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = {
  urgent: 'danger',
  high: 'warning',
  medium: 'neutral',
  low: 'neutral',
};

export function TasksView({
  rows,
  pagination,
  scope,
}: {
  rows: TaskRow[];
  pagination: Pagination;
  scope: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [completing, setCompleting] = React.useState<string | null>(null);

  const complete = async (task: TaskRow) => {
    setCompleting(task.id);
    try {
      const response = await fetch(`/api/v1/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      });

      const body = (await response.json()) as {
        error?: { message: string; details?: { blocked_by?: string[] } };
      };

      if (!response.ok) {
        // A blocked task names what it is waiting on, rather than just refusing.
        toast.error(body.error?.message ?? 'Could not complete this task.', {
          description: body.error?.details?.blocked_by
            ? `Waiting on: ${body.error.details.blocked_by.join(', ')}`
            : undefined,
        });
        return;
      }

      toast.success('Task completed');
      router.refresh();
    } finally {
      setCompleting(null);
    }
  };

  const columns: Column<TaskRow>[] = [
    {
      key: 'title',
      header: 'Task',
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.title}</p>
          {row.project_name ? (
            <Link
              href={`/projects/${row.id}`}
              className="truncate text-xs text-muted-foreground hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {row.project_code} · {row.project_name}
            </Link>
          ) : row.company_name ? (
            <p className="truncate text-xs text-muted-foreground">{row.company_name}</p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'priority',
      header: 'Priority',
      sortable: true,
      render: (row) => (
        <Badge variant={PRIORITY_TONE[row.priority] ?? 'neutral'}>{row.priority}</Badge>
      ),
    },
    {
      key: 'assignee_name',
      header: 'Assignee',
      optional: true,
      render: (row) => row.assignee_name ?? <span className="text-muted-foreground">Unassigned</span>,
    },
    {
      key: 'due_date',
      header: 'Due',
      sortable: true,
      render: (row) =>
        row.due_date ? (
          <span className={row.is_overdue ? 'font-medium text-destructive' : undefined}>
            {formatDate(row.due_date)}
            {row.is_overdue ? <span className="sr-only"> (overdue)</span> : null}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) =>
        row.status === 'done' || row.status === 'cancelled' ? null : (
          <Button
            size="sm"
            variant="ghost"
            loading={completing === row.id}
            onClick={(e) => {
              e.stopPropagation();
              void complete(row);
            }}
          >
            <Check className="h-3.5 w-3.5" />
            Done
          </Button>
        ),
    },
  ];

  return (
    <DataTable
      rows={rows}
      columns={columns}
      pagination={pagination}
      searchPlaceholder="Search tasks…"
      emptyIcon={CheckSquare}
      emptyTitle={scope === 'mine' ? 'Nothing assigned to you' : 'No tasks'}
      emptyDescription={
        scope === 'overdue'
          ? 'Nothing is overdue. '
          : 'Tasks are created from a project plan or added directly.'
      }
      toolbar={
        <div className="flex flex-wrap gap-1">
          {SCOPES.map((item) => (
            <Button
              key={item.key}
              size="sm"
              variant={scope === item.key ? 'secondary' : 'ghost'}
              onClick={() => {
                const next = new URLSearchParams(params.toString());
                next.set('scope', item.key);
                next.delete('page');
                router.push(`/tasks?${next.toString()}`);
              }}
            >
              {item.label}
            </Button>
          ))}
        </div>
      }
    />
  );
}
