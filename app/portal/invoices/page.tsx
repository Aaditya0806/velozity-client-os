import type { Metadata } from 'next';
import { Receipt } from 'lucide-react';
import { redirect } from 'next/navigation';
import { requirePortalContext, portalQuery } from '@/lib/auth/portal';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDate, daysUntil } from '@/lib/util/format';
import { formatMoney } from '@/lib/util/money';

export const metadata: Metadata = { title: 'Invoices' };
export const dynamic = 'force-dynamic';

interface InvoiceRow {
  id: string;
  reference: string;
  status: string;
  currency: string;
  total: string;
  amount_paid: string;
  balance_due: string;
  issue_date: string | null;
  due_date: string | null;
  paid_at: string | null;
}

export default async function PortalInvoicesPage() {
  const ctx = await requirePortalContext();
  if (!ctx.company.capabilities.viewInvoices) redirect('/portal');

  const invoices = await portalQuery(ctx, (tx) =>
    tx.many<InvoiceRow>(
      `select id, reference, status, currency, total, amount_paid, balance_due,
              issue_date, due_date, paid_at
         from portal.invoices
        order by issue_date desc nulls last`,
    ),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Issued invoices for {ctx.company.name}. Drafts are never shown here.
        </p>
      </div>

      {invoices.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="No invoices yet"
          description="Invoices appear here once they have been issued."
        />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[42rem] text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-5 py-3 font-medium">Reference</th>
                  <th scope="col" className="px-5 py-3 font-medium">Issued</th>
                  <th scope="col" className="px-5 py-3 font-medium">Due</th>
                  <th scope="col" className="px-5 py-3 text-right font-medium">Total</th>
                  <th scope="col" className="px-5 py-3 text-right font-medium">Outstanding</th>
                  <th scope="col" className="px-5 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {invoices.map((invoice) => {
                  const days = daysUntil(invoice.due_date);
                  const overdue =
                    invoice.status !== 'paid' && days !== null && days < 0;
                  return (
                    <tr key={invoice.id} className="hover:bg-accent/40">
                      <td className="px-5 py-3.5 font-mono text-xs">{invoice.reference}</td>
                      <td className="px-5 py-3.5">{formatDate(invoice.issue_date) || '—'}</td>
                      <td className="px-5 py-3.5">
                        {formatDate(invoice.due_date) || '—'}
                        {overdue ? (
                          <span className="ml-1.5 text-xs font-medium text-destructive">
                            {Math.abs(days)}d overdue
                          </span>
                        ) : null}
                      </td>
                      <td className="tabular px-5 py-3.5 text-right">
                        {formatMoney(invoice.total, invoice.currency)}
                      </td>
                      <td className="tabular px-5 py-3.5 text-right font-medium">
                        {formatMoney(invoice.balance_due, invoice.currency)}
                      </td>
                      <td className="px-5 py-3.5">
                        <StatusBadge status={invoice.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
