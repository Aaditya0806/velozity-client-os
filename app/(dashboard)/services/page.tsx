import type { Metadata } from 'next';
import Link from 'next/link';
import { Package, Clock, FileCheck, Target } from 'lucide-react';
import { requireContext, query } from '@/lib/auth/session';
import { listServices, serviceListSchema } from '@/lib/services/services-catalog';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { formatMoney } from '@/lib/util/format';

export const metadata: Metadata = { title: 'Services' };
export const dynamic = 'force-dynamic';

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireContext();
  const params = await searchParams;

  const parsed = serviceListSchema.safeParse(params);
  const listQuery = parsed.success ? parsed.data : serviceListSchema.parse({});

  const result = await query(ctx, (tx) => listServices(tx, ctx, listQuery), { readOnly: true });
  const services = result.rows as Array<Record<string, unknown>>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Services"
        description="What you sell, how it is priced, and what must be signed before it is delivered."
      />

      {services.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No services yet"
          description="A service defines its price, its delivery plan, its KPIs and the documents that must be executed before work can start."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {services.map((service) => (
            <Card key={String(service.id)}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      href={`/services/${String(service.id)}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {String(service.name)}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {String(service.code)}
                      {service.category_name ? ` · ${String(service.category_name)}` : ''}
                    </p>
                  </div>
                  {!service.is_active ? <Badge variant="neutral">Inactive</Badge> : null}
                </div>

                {service.short_description ? (
                  <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                    {String(service.short_description)}
                  </p>
                ) : null}

                <p className="tabular mt-3 text-lg font-semibold">
                  {formatMoney(String(service.base_price), String(service.currency))}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    per {String(service.unit_label)}
                  </span>
                </p>

                <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" aria-hidden />
                    {String(service.default_task_count)} tasks
                  </span>
                  <span className="flex items-center gap-1">
                    <Target className="h-3 w-3" aria-hidden />
                    {String(service.default_kpi_count)} KPIs
                  </span>
                  <span className="flex items-center gap-1">
                    <FileCheck className="h-3 w-3" aria-hidden />
                    {String(service.required_document_count)} required docs
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
