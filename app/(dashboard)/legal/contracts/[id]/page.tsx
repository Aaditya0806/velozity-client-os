import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ShieldCheck, Lock } from 'lucide-react';
import { requireContext, query } from '@/lib/auth/session';
import { getContract, contractReadiness } from '@/lib/services/contracts';
import { getTransitionHistory } from '@/lib/services/opportunities';
import { isAppError } from '@/lib/http/errors';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate, formatDateTime, formatMoney } from '@/lib/util/format';
import { ContractActions } from './contract-actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const ctx = await requireContext();
    const contract = await query(ctx, (tx) => getContract(tx, ctx, id), { readOnly: true });
    return { title: String(contract.reference) };
  } catch {
    return { title: 'Contract' };
  }
}

export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext();

  let contract;
  let readiness;
  let history;
  try {
    ({ contract, readiness, history } = await query(
      ctx,
      async (tx) => ({
        contract: await getContract(tx, ctx, id),
        readiness: await contractReadiness(tx, id),
        history: await getTransitionHistory(tx, 'contract', id),
      }),
      { readOnly: true },
    ));
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const status = String(contract.status);
  const executed = status === 'fully_executed';
  const signers = contract.signers as Array<Record<string, unknown>>;

  return (
    <div className="space-y-6">
      <PageHeader
        title={String(contract.title)}
        breadcrumbs={[
          { label: 'Legal', href: '/legal' },
          { label: String(contract.reference) },
        ]}
        meta={
          <>
            <StatusBadge status={status} />
            <Badge variant="outline">{String(contract.contract_type).toUpperCase()}</Badge>
            <Link
              href={`/clients/${String(contract.company_id)}`}
              className="text-sm text-primary hover:underline"
            >
              {String(contract.company_name)}
            </Link>
            {contract.origin === 'client_paper' ? (
              <Badge variant="warning">Client paper</Badge>
            ) : null}
          </>
        }
        actions={
          <ContractActions
            contractId={id}
            status={status}
            ready={readiness.ready}
            reference={String(contract.reference)}
            canApprove={ctx.permissions.has('contract:approve:org')}
            canSend={ctx.permissions.has('contract:send:org')}
            canVoid={ctx.permissions.has('contract:void:org')}
            canEdit={ctx.permissions.can('contract', 'update')}
            signerCount={signers.length}
          />
        }
      />

      {executed ? (
        <div className="flex items-start gap-3 rounded-lg border border-[hsl(var(--success))]/40 bg-[hsl(var(--success))]/[0.05] p-4">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--success))]" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-[hsl(var(--success))]">Fully executed</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Signed by all parties on {formatDate(contract.executed_at as string)}. This contract
              and its executed document are sealed: changing anything requires an amendment that
              references it.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Signers</CardTitle>
            </CardHeader>
            <CardContent>
              {signers.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">
                  No signers have been set. A contract needs at least one from each side before it
                  can be sent.
                </p>
              ) : (
                <ul className="divide-y">
                  {signers.map((signer) => (
                    <li
                      key={String(signer.id)}
                      className="flex items-center justify-between gap-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{String(signer.name)}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {String(signer.email)} · {String(signer.party)}
                          {signer.signing_order ? ` · order ${String(signer.signing_order)}` : ''}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <StatusBadge status={String(signer.status)} />
                        {signer.signed_at ? (
                          <span className="text-xs text-muted-foreground">
                            {formatDate(signer.signed_at as string)}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {!readiness.ready && readiness.missing.length > 0 ? (
            <Card className="border-[hsl(var(--warning))]/40">
              <CardHeader>
                <CardTitle className="text-[hsl(var(--warning))]">
                  Missing values
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-3 text-sm text-muted-foreground">
                  The document cannot be produced until these are supplied. Nothing is
                  guessed or defaulted.
                </p>
                <ul className="space-y-1.5 text-sm">
                  {readiness.missing.map((variable) => (
                    <li key={variable.key} className="flex items-baseline gap-2">
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                        {variable.key}
                      </code>
                      <span>{variable.label}</span>
                      {variable.source_hint ? (
                        <span className="text-xs text-muted-foreground">
                          usually from {variable.source_hint}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent>
              {history.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">Nothing has happened yet.</p>
              ) : (
                <ol className="space-y-3">
                  {history.map((entry) => {
                    const row = entry as Record<string, unknown>;
                    return (
                      <li key={String(row.id)} className="flex items-start gap-3 text-sm">
                        <div className="flex flex-1 flex-wrap items-baseline gap-x-2">
                          <span className="text-muted-foreground">
                            {String(row.from_state ?? 'created')}
                          </span>
                          <span aria-hidden>→</span>
                          <StatusBadge status={String(row.to_state)} />
                          {row.reason ? (
                            <span className="w-full text-muted-foreground">{String(row.reason)}</span>
                          ) : null}
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {row.actor_name ? `${String(row.actor_name)} · ` : `${String(row.actor_type)} · `}
                          {formatDateTime(row.occurred_at as string, ctx.org.timezone)}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-sm">
              <Row label="Reference">{String(contract.reference)}</Row>
              <Row label="Value">
                {contract.contract_value && contract.currency
                  ? formatMoney(String(contract.contract_value), String(contract.currency))
                  : '—'}
              </Row>
              <Row label="Effective">{formatDate(contract.effective_date as string)}</Row>
              <Row label="Expires">{formatDate(contract.expiry_date as string)}</Row>
              <Row label="Approved by">{(contract.approved_by_name as string) ?? '—'}</Row>
              <Row label="Sent by">{(contract.sent_by_name as string) ?? '—'}</Row>
              {contract.parent_contract_reference ? (
                <Row label="Amends">{String(contract.parent_contract_reference)}</Row>
              ) : null}
            </CardContent>
          </Card>

          {contract.executed_document_id ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  Executed document
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-muted-foreground">
                  Stored immutably. Its SHA-256 is verified against the bytes we
                  received from the signature provider.
                </p>
                <a
                  href={`/api/v1/documents/${String(contract.executed_document_id)}/download?verify=true`}
                  className="inline-block text-primary hover:underline"
                >
                  Download and verify
                </a>
              </CardContent>
            </Card>
          ) : null}

          {(contract.amendments as Array<Record<string, unknown>>).length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Amendments</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {(contract.amendments as Array<Record<string, unknown>>).map((amendment) => (
                    <li key={String(amendment.id)}>
                      <Link
                        href={`/legal/contracts/${String(amendment.id)}`}
                        className="text-sm text-primary hover:underline"
                      >
                        {String(amendment.reference)}
                      </Link>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {String(amendment.status).replace(/_/g, ' ')}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate text-right">{children}</span>
    </div>
  );
}
