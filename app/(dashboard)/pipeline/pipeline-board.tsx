'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GripVertical, AlertTriangle } from 'lucide-react';
import { statusLabel } from '@/components/ui/status-badge';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { formatMoney, formatDate, daysUntil } from '@/lib/util/format';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/util/cn';
import { TransitionDialog } from './transition-dialog';

interface Opportunity {
  id: string;
  reference: string;
  name: string;
  stage: string;
  amount: string;
  currency: string;
  probability: number;
  expected_close_date: string | null;
  company_name: string;
  owner_name: string | null;
  is_overdue: boolean;
}

/**
 * The pipeline board.
 *
 * Dragging a card requests a *transition*, not a field update: the server runs
 * the guards and may refuse. When it does, the card returns to its column and
 * the reason is shown — an optimistic move that silently fails would be worse
 * than no drag at all.
 */
export function PipelineBoard({
  opportunities,
  stages,
  total,
  truncated,
  baseCurrency,
  canTransition,
}: {
  opportunities: Opportunity[];
  stages: string[];
  total: number;
  truncated: boolean;
  baseCurrency: string;
  canTransition: boolean;
}) {
  const router = useRouter();
  const [items, setItems] = React.useState(opportunities);
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<{
    opportunity: Opportunity;
    to: string;
  } | null>(null);

  React.useEffect(() => setItems(opportunities), [opportunities]);

  const byStage = React.useMemo(() => {
    const map = new Map<string, Opportunity[]>();
    for (const stage of stages) map.set(stage, []);
    for (const item of items) {
      map.get(item.stage)?.push(item);
    }
    return map;
  }, [items, stages]);

  const move = async (opportunity: Opportunity, to: string, reason?: string, payload?: Record<string, unknown>) => {
    const previousStage = opportunity.stage;

    // Optimistic, then reverted precisely if the server refuses.
    setItems((current) =>
      current.map((o) => (o.id === opportunity.id ? { ...o, stage: to } : o)),
    );

    const response = await fetch(`/api/v1/opportunities/${opportunity.id}/transitions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, reason: reason ?? null, payload: payload ?? {} }),
    });

    if (!response.ok) {
      const body = (await response.json()) as {
        error: { code: string; message: string; details?: { missing?: string[] } };
        request_id: string;
      };

      setItems((current) =>
        current.map((o) => (o.id === opportunity.id ? { ...o, stage: previousStage } : o)),
      );

      const missing = body.error.details?.missing;
      toast.error(body.error.message, {
        description: missing
          ? `Missing: ${missing.join(', ')}`
          : `Reference ${body.request_id}`,
        action: {
          label: 'Open deal',
          onClick: () => router.push(`/pipeline/${opportunity.id}`),
        },
      });
      return false;
    }

    toast.success(`Moved to ${statusLabel(to)}`);
    router.refresh();
    return true;
  };

  const onDrop = async (stage: string) => {
    setDropTarget(null);
    const id = dragging;
    setDragging(null);
    if (!id) return;

    const opportunity = items.find((o) => o.id === id);
    if (!opportunity || opportunity.stage === stage) return;

    // Some targets need information the board cannot supply, so they open a
    // dialog instead of moving straight away.
    if (stage === 'lost' || stage === 'dormant') {
      setPending({ opportunity, to: stage });
      return;
    }

    await move(opportunity, stage);
  };

  if (items.length === 0) {
    return (
      <EmptyState
        title="No open opportunities"
        description="Deals appear on this board while they are in play. Won and lost deals move off it."
      />
    );
  }

  return (
    <>
      {truncated ? (
        <p className="flex items-center gap-2 rounded-md border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/[0.06] px-3 py-2 text-sm text-[hsl(var(--warning))]">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          Showing the {items.length} most recently updated of {total} open deals.
        </p>
      ) : null}

      <div className="scrollbar-thin -mx-4 flex gap-4 overflow-x-auto px-4 pb-4 sm:mx-0 sm:px-0">
        {stages.map((stage) => {
          const cards = byStage.get(stage) ?? [];
          const stageTotal = cards.reduce((sum, c) => sum + Number.parseFloat(c.amount || '0'), 0);

          return (
            <section
              key={stage}
              className={cn(
                'flex w-72 shrink-0 flex-col rounded-lg border bg-muted/30 transition-colors',
                dropTarget === stage && 'border-primary bg-primary/[0.04]',
              )}
              onDragOver={(e) => {
                if (!canTransition) return;
                e.preventDefault();
                setDropTarget(stage);
              }}
              onDragLeave={() => setDropTarget((current) => (current === stage ? null : current))}
              onDrop={() => void onDrop(stage)}
              aria-label={`${statusLabel(stage)} column, ${cards.length} deals`}
            >
              <header className="flex items-baseline justify-between gap-2 border-b px-3 py-2.5">
                <h2 className="text-sm font-medium">{statusLabel(stage)}</h2>
                <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                  <span className="tabular">{cards.length}</span>
                  {stageTotal > 0 ? (
                    <span className="tabular">
                      {formatMoney(stageTotal, cards[0]?.currency ?? baseCurrency, 'en-GB', {
                        compact: true,
                      })}
                    </span>
                  ) : null}
                </div>
              </header>

              <div className="scrollbar-thin flex-1 space-y-2 overflow-y-auto p-2">
                {cards.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    Nothing here
                  </p>
                ) : (
                  cards.map((card) => {
                    const days = daysUntil(card.expected_close_date);
                    return (
                      <article
                        key={card.id}
                        draggable={canTransition}
                        onDragStart={() => setDragging(card.id)}
                        onDragEnd={() => {
                          setDragging(null);
                          setDropTarget(null);
                        }}
                        className={cn(
                          'group rounded-md border bg-card p-3 shadow-sm transition-opacity',
                          canTransition && 'cursor-grab active:cursor-grabbing',
                          dragging === card.id && 'opacity-40',
                        )}
                      >
                        <div className="flex items-start gap-1.5">
                          {canTransition ? (
                            <GripVertical
                              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                              aria-hidden
                            />
                          ) : null}
                          <div className="min-w-0 flex-1">
                            <Link
                              href={`/pipeline/${card.id}`}
                              className="block truncate text-sm font-medium hover:underline"
                            >
                              {card.name}
                            </Link>
                            <p className="truncate text-xs text-muted-foreground">
                              {card.company_name}
                            </p>
                          </div>
                        </div>

                        <div className="mt-2.5 flex items-center justify-between gap-2">
                          <span className="tabular text-sm font-medium">
                            {formatMoney(card.amount, card.currency, 'en-GB', { compact: true })}
                          </span>
                          {card.expected_close_date ? (
                            <Badge variant={card.is_overdue ? 'danger' : days !== null && days < 14 ? 'warning' : 'neutral'}>
                              {card.is_overdue ? 'Overdue' : formatDate(card.expected_close_date)}
                            </Badge>
                          ) : null}
                        </div>

                        {card.owner_name ? (
                          <p className="mt-1.5 truncate text-xs text-muted-foreground">
                            {card.owner_name}
                          </p>
                        ) : null}
                      </article>
                    );
                  })
                )}
              </div>
            </section>
          );
        })}
      </div>

      {pending ? (
        <TransitionDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setPending(null);
              // The optimistic move never happened for these targets, but the
              // board may still be showing a hover state.
              setItems(opportunities);
            }
          }}
          to={pending.to}
          opportunityName={pending.opportunity.name}
          onConfirm={async (reason, payload) => {
            const ok = await move(pending.opportunity, pending.to, reason, payload);
            if (ok) setPending(null);
          }}
        />
      ) : null}
    </>
  );
}
