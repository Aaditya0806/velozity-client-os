'use client';

import * as React from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { ArrowUpDown, ArrowUp, ArrowDown, Search, X, ChevronLeft, ChevronRight, Settings2 } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from './table';
import { Button } from './button';
import { Input } from './input';
import { EmptyState } from './empty-state';
import { SkeletonTable } from './skeleton';
import { cn } from '@/lib/util/cn';
import type { LucideIcon } from 'lucide-react';

export interface Column<T> {
  key: string;
  header: string;
  /** Whether the server supports sorting by this column. */
  sortable?: boolean;
  /** Hidden by default; the user can turn it on. */
  optional?: boolean;
  align?: 'left' | 'right';
  className?: string;
  render: (row: T) => React.ReactNode;
}

export interface Pagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  has_more: boolean;
}

/**
 * The list table used across the product.
 *
 * Sorting, paging and search live in the URL rather than in component state, so
 * a filtered view is a link a colleague can be sent, and the back button does
 * what a user expects.
 */
export function DataTable<T extends { id: string }>({
  rows,
  columns,
  pagination,
  loading = false,
  emptyTitle,
  emptyDescription,
  emptyIcon,
  emptyAction,
  searchPlaceholder = 'Search…',
  onRowClick,
  toolbar,
}: {
  rows: T[];
  columns: Column<T>[];
  pagination?: Pagination;
  loading?: boolean;
  emptyTitle: string;
  emptyDescription?: string;
  emptyIcon?: LucideIcon;
  emptyAction?: React.ReactNode;
  searchPlaceholder?: string;
  onRowClick?: (row: T) => void;
  toolbar?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const currentSort = params.get('sort');
  const currentDirection = params.get('direction') ?? 'desc';
  const [search, setSearch] = React.useState(params.get('q') ?? '');
  const [hidden, setHidden] = React.useState<Set<string>>(
    () => new Set(columns.filter((c) => c.optional).map((c) => c.key)),
  );

  const update = React.useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      // Any change other than paging returns to the first page, otherwise a
      // filter can leave you on a page that no longer exists.
      if (!('page' in changes)) next.delete('page');
      router.push(`${pathname}?${next.toString()}`);
    },
    [params, pathname, router],
  );

  // Debounced search so typing does not push a history entry per keystroke.
  React.useEffect(() => {
    const current = params.get('q') ?? '';
    if (search === current) return;
    const timer = setTimeout(() => update({ q: search || null }), 300);
    return () => clearTimeout(timer);
  }, [search, params, update]);

  const toggleSort = (key: string) => {
    if (currentSort === key) {
      update({ sort: key, direction: currentDirection === 'asc' ? 'desc' : 'asc' });
    } else {
      update({ sort: key, direction: 'asc' });
    }
  };

  const visible = columns.filter((c) => !hidden.has(c.key));
  const optional = columns.filter((c) => c.optional);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchPlaceholder}
            className="pl-8 pr-8"
            aria-label={searchPlaceholder}
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
              <span className="sr-only">Clear search</span>
            </button>
          ) : null}
        </div>

        <div className="flex flex-1 items-center justify-end gap-2">
          {toolbar}
          {optional.length > 0 ? (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button variant="outline" size="sm">
                  <Settings2 className="h-3.5 w-3.5" />
                  Columns
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={6}
                  className="z-50 w-48 rounded-lg border bg-popover p-1 shadow-lg"
                >
                  {optional.map((column) => (
                    <DropdownMenu.CheckboxItem
                      key={column.key}
                      checked={!hidden.has(column.key)}
                      onCheckedChange={(checked) =>
                        setHidden((current) => {
                          const next = new Set(current);
                          if (checked) next.delete(column.key);
                          else next.add(column.key);
                          return next;
                        })
                      }
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent"
                    >
                      <span className="flex h-4 w-4 items-center justify-center">
                        {!hidden.has(column.key) ? '✓' : ''}
                      </span>
                      {column.header}
                    </DropdownMenu.CheckboxItem>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ) : null}
        </div>
      </div>

      <div className="rounded-lg border">
        {loading ? (
          <SkeletonTable columns={visible.length} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={emptyIcon}
            title={emptyTitle}
            description={emptyDescription}
            action={emptyAction}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {visible.map((column) => (
                  <TableHead
                    key={column.key}
                    className={cn(column.align === 'right' && 'text-right', column.className)}
                    aria-sort={
                      currentSort === column.key
                        ? currentDirection === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        className={cn(
                          'inline-flex items-center gap-1 rounded transition-colors hover:text-foreground',
                          column.align === 'right' && 'flex-row-reverse',
                        )}
                      >
                        {column.header}
                        {currentSort === column.key ? (
                          currentDirection === 'asc' ? (
                            <ArrowUp className="h-3 w-3" aria-hidden />
                          ) : (
                            <ArrowDown className="h-3 w-3" aria-hidden />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={onRowClick ? 'cursor-pointer' : undefined}
                >
                  {visible.map((column) => (
                    <TableCell
                      key={column.key}
                      className={cn(column.align === 'right' && 'text-right tabular', column.className)}
                    >
                      {column.render(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {pagination && pagination.total > 0 ? (
        <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <p>
            {(pagination.page - 1) * pagination.page_size + 1}–
            {Math.min(pagination.page * pagination.page_size, pagination.total)} of{' '}
            <span className="tabular">{pagination.total}</span>
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => update({ page: String(pagination.page - 1) })}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!pagination.has_more}
              onClick={() => update({ page: String(pagination.page + 1) })}
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
