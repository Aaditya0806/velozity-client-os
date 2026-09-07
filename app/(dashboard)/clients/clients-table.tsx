'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Building2 } from 'lucide-react';
import { DataTable, type Column, type Pagination } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDate } from '@/lib/util/format';
import { NewClientButton } from './new-client-button';

interface ClientRow {
  id: string;
  name: string;
  legal_name: string | null;
  lifecycle_stage: string;
  industry: string | null;
  owner_name: string | null;
  health_status: string | null;
  parent_company_name: string | null;
  open_opportunity_count: string;
  active_project_count: string;
  created_at: string;
}

export function ClientsTable({
  rows,
  pagination,
  canCreate,
}: {
  rows: ClientRow[];
  pagination: Pagination;
  canCreate: boolean;
}) {
  const router = useRouter();

  const columns: Column<ClientRow>[] = [
    {
      key: 'name',
      header: 'Client',
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <Link
            href={`/clients/${row.id}`}
            className="block truncate font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.name}
          </Link>
          {row.parent_company_name ? (
            <p className="truncate text-xs text-muted-foreground">
              Part of {row.parent_company_name}
            </p>
          ) : row.legal_name && row.legal_name !== row.name ? (
            <p className="truncate text-xs text-muted-foreground">{row.legal_name}</p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'lifecycle_stage',
      header: 'Stage',
      sortable: true,
      render: (row) => <StatusBadge status={row.lifecycle_stage} />,
    },
    {
      key: 'industry',
      header: 'Industry',
      optional: true,
      render: (row) => row.industry ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'owner_name',
      header: 'Owner',
      render: (row) =>
        row.owner_name ?? <span className="text-muted-foreground">Unassigned</span>,
    },
    {
      key: 'open_opportunity_count',
      header: 'Open deals',
      align: 'right',
      render: (row) => row.open_opportunity_count,
    },
    {
      key: 'active_project_count',
      header: 'Projects',
      align: 'right',
      render: (row) => row.active_project_count,
    },
    {
      key: 'health_status',
      header: 'Health',
      render: (row) =>
        row.health_status ? (
          <StatusBadge status={row.health_status} />
        ) : (
          <Badge variant="neutral">Not scored</Badge>
        ),
    },
    {
      key: 'created_at',
      header: 'Added',
      sortable: true,
      optional: true,
      render: (row) => formatDate(row.created_at),
    },
  ];

  return (
    <DataTable
      rows={rows}
      columns={columns}
      pagination={pagination}
      searchPlaceholder="Search clients…"
      emptyIcon={Building2}
      emptyTitle="No clients yet"
      emptyDescription="Clients appear here once you add one or capture an inbound lead."
      emptyAction={canCreate ? <NewClientButton /> : undefined}
      onRowClick={(row) => router.push(`/clients/${row.id}`)}
    />
  );
}
