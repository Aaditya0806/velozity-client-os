import { formatMoney } from '@/lib/util/format';
import { statusLabel } from '@/components/ui/status-badge';

const STAGE_ORDER = [
  'lead', 'qualified', 'discovery', 'diagnosis', 'solution', 'proposal_sent', 'negotiation',
];

/**
 * The funnel, as proportional bars.
 *
 * A bar chart library would be a dependency and an accessibility problem for
 * seven values; a definition list with proportional widths reads correctly to a
 * screen reader and needs no JavaScript at all.
 */
export function PipelineFunnel({
  stages,
  currency,
}: {
  stages: Array<{ stage: string; count: string; value_base: string }>;
  currency: string;
}) {
  const byStage = new Map(stages.map((s) => [s.stage, s]));
  const max = Math.max(
    ...stages.map((s) => Number.parseFloat(s.value_base) || 0),
    1,
  );

  return (
    <dl className="space-y-2.5">
      {STAGE_ORDER.map((stage) => {
        const row = byStage.get(stage);
        const value = row ? Number.parseFloat(row.value_base) : 0;
        const count = row ? Number.parseInt(row.count, 10) : 0;
        const width = Math.max(2, Math.round((value / max) * 100));

        return (
          <div key={stage} className="grid grid-cols-[9rem_1fr_auto] items-center gap-3">
            <dt className="truncate text-sm text-muted-foreground">{statusLabel(stage)}</dt>
            <dd className="flex items-center gap-2">
              <div className="h-5 flex-1 overflow-hidden rounded bg-muted">
                <div
                  className="h-full rounded bg-primary/70 transition-[width]"
                  style={{ width: `${count > 0 ? width : 0}%` }}
                />
              </div>
              <span className="tabular w-8 shrink-0 text-right text-xs text-muted-foreground">
                {count}
              </span>
            </dd>
            <dd className="tabular w-24 text-right text-sm font-medium">
              {count > 0 ? formatMoney(value, currency, 'en-GB', { compact: true }) : '—'}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
