import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireContext, query } from '@/lib/auth/session';
import { getOpportunity, getTransitionHistory } from '@/lib/services/opportunities';
import { opportunityMachine } from '@/lib/workflows/machines';
import { availableTransitions } from '@/lib/workflows/state-machine';
import { isAppError } from '@/lib/http/errors';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatMoney, formatDate, formatDateTime } from '@/lib/util/format';
import { StageActions } from './stage-actions';
import { QualificationPanel } from './qualification-panel';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const ctx = await requireContext();
    const opportunity = await query(ctx, (tx) => getOpportunity(tx, ctx, id), { readOnly: true });
    return { title: String(opportunity.name) };
  } catch {
    return { title: 'Opportunity' };
  }
}

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext();

  let opportunity;
  let history;
  try {
    ({ opportunity, history } = await query(
      ctx,
      async (tx) => ({
        opportunity: await getOpportunity(tx, ctx, id),
        history: await getTransitionHistory(tx, 'opportunity', id),
      }),
      { readOnly: true },
    ));
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const stage = String(opportunity.stage);
  const available = availableTransitions(opportunityMachine, stage);
  const canUpdate = ctx.permissions.can('opportunity', 'update');

  return (
    <div className="space-y-6">
      <PageHeader
        title={String(opportunity.name)}
        breadcrumbs={[
          { label: 'Pipeline', href: '/pipeline' },
          { label: String(opportunity.reference) },
        ]}
        meta={
          <>
            <StatusBadge status={stage} />
            <Link
              href={`/clients/${String(opportunity.company_id)}`}
              className="text-sm text-primary hover:underline"
            >
              {String(opportunity.company_name)}
            </Link>
            <Badge variant="outline">{String(opportunity.reference)}</Badge>
          </>
        }
        actions={
          canUpdate && available.length > 0 ? (
            <StageActions
              opportunityId={id}
              currentStage={stage}
              available={available}
              opportunityName={String(opportunity.name)}
            />
          ) : null
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <QualificationPanel
            opportunityId={id}
            stage={stage}
            businessProblem={(opportunity.business_problem as string) ?? null}
            budgetIndication={(opportunity.budget_indication as string) ?? null}
            budgetCurrency={(opportunity.budget_currency as string) ?? null}
            decisionMakerId={(opportunity.decision_maker_contact_id as string) ?? null}
            decisionMakerName={(opportunity.decision_maker_name as string) ?? null}
            companyId={String(opportunity.company_id)}
            canEdit={canUpdate}
          />

          {opportunity.description ? (
            <Card>
              <CardHeader>
                <CardTitle>Description</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm">{String(opportunity.description)}</p>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Stage history</CardTitle>
            </CardHeader>
            <CardContent>
              {history.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">
                  This deal has not changed stage yet.
                </p>
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
                            <span className="w-full text-muted-foreground">
                              {String(row.reason)}
                            </span>
                          ) : null}
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {row.actor_name ? `${String(row.actor_name)} · ` : ''}
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
              <CardTitle>Commercials</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-sm">
              <Row label="Value">
                <span className="tabular font-medium">
                  {formatMoney(String(opportunity.amount), String(opportunity.currency))}
                </span>
              </Row>
              <Row label="Probability">{String(opportunity.probability)}%</Row>
              <Row label="Expected close">
                {formatDate(opportunity.expected_close_date as string)}
              </Row>
              <Row label="Owner">
                {(opportunity.owner_name as string) ?? 'Unassigned'}
              </Row>
              <Row label="Source">{(opportunity.source as string) ?? '—'}</Row>
              {opportunity.won_at ? (
                <Row label="Won">{formatDate(opportunity.won_at as string)}</Row>
              ) : null}
              {opportunity.lost_reason ? (
                <Row label="Lost because">
                  <StatusBadge status={String(opportunity.lost_reason)} />
                </Row>
              ) : null}
            </CardContent>
          </Card>

          {opportunity.accepted_proposal_version_id ? (
            <Card className="border-[hsl(var(--success))]/40">
              <CardHeader>
                <CardTitle className="text-[hsl(var(--success))]">Accepted proposal</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                <p className="text-muted-foreground">
                  This deal is locked to the proposal version the client accepted.
                  Any agreement generated from it uses that version, whatever changes
                  are made here afterwards.
                </p>
              </CardContent>
            </Card>
          ) : null}

          {'internal_notes' in opportunity && opportunity.internal_notes ? (
            <Card>
              <CardHeader>
                <CardTitle>Internal notes</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm">
                  {String(opportunity.internal_notes)}
                </p>
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
