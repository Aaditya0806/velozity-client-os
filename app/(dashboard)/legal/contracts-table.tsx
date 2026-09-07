'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Scale } from 'lucide-react';
import { DataTable, type Column, type Pagination } from '@/components/ui/data-table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDate, formatMoney, daysUntil } from '@/lib/util/format';

interface ContractRow {
  id: string;
  reference: string;
  title: string;
  contract_type: string;
  status: string;
  company_name: string;
  currency: string | null;
  contract_value: string | null;
  sent_at: string | null;
  executed_at: string | null;
  expiry_date: string | null;
  signer_count: string;
  signed_count: string;
}

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'internal_review', label: 'In review' },
  { key: 'approved_to_send', label: 'Approved' },
  { key: 'sent', label: 'Sent' },
  { key: 'fully_executed', label: 'Executed' },
];

export function ContractsTable({
  rows,
  pagination,
}: {
  rows: ContractRow[];
  pagination: Pagination;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const activeStatus = params.get('status') ?? '';

  const columns: Column<ContractRow>[] = [
    {
      key: 'title',
      header: 'Contract',
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <Link
            href={`/legal/contracts/${row.id}`}
            className="block truncate font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.title}
          </Link>
          <p className="truncate text-xs text-muted-foreground">
            {row.reference} · {row.company_name}
          </p>
        </div>
      ),
    },
    {
      key: 'contract_type',
      header: 'Type',
      sortable: true,
      render: (row) => <Badge variant="outline">{row.contract_type.toUpperCase()}</Badge>,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'signatures',
      header: 'Signatures',
      align: 'right',
      render: (row) => {
        const signed = Number.parseInt(row.signed_count, 10);
        const total = Number.parseInt(row.signer_count, 10);
        if (total === 0) return <span className="text-muted-foreground">—</span>;
        return (
          <span className={signed === total ? 'text-[hsl(var(--success))]' : undefined}>
            {signed}/{total}
          </span>
        );
      },
    },
    {
      key: 'contract_value',
      header: 'Value',
      align: 'right',
      optional: true,
      render: (row) =>
        row.contract_value && row.currency ? (
          formatMoney(row.contract_value, row.currency)
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'expiry_date',
      header: 'Expires',
      sortable: true,
      render: (row) => {
        if (!row.expiry_date) return <span className="text-muted-foreground">—</span>;
        const days = daysUntil(row.expiry_date);
        return (
          <span className={days !== null && days < 60 ? 'text-[hsl(var(--warning))]' : undefined}>
            {formatDate(row.expiry_date)}
          </span>
        );
      },
    },
  ];

  return (
    <DataTable
      rows={rows}
      columns={columns}
      pagination={pagination}
      searchPlaceholder="Search contracts…"
      emptyIcon={Scale}
      emptyTitle="No contracts"
      emptyDescription="Contracts appear here once they are drafted from a template or uploaded."
      onRowClick={(row) => router.push(`/legal/contracts/${row.id}`)}
      toolbar={
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((filter) => (
            <Button
              key={filter.key || 'all'}
              size="sm"
              variant={activeStatus === filter.key ? 'secondary' : 'ghost'}
              onClick={() => {
                const next = new URLSearchParams(params.toString());
                if (filter.key) next.set('status', filter.key);
                else next.delete('status');
                next.delete('page');
                router.push(`/legal?${next.toString()}`);
              }}
            >
              {filter.label}
            </Button>
          ))}
        </div>
      }
    />
  );
}
