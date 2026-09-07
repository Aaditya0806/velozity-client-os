import { Badge, type BadgeProps } from './badge';

/**
 * Status colour, defined once.
 *
 * Every lifecycle status in the product maps to a tone here, so the same state
 * looks the same everywhere and nobody has to remember whether "sent" is blue on
 * this screen and grey on that one.
 */
type Tone = NonNullable<BadgeProps['variant']>;

const TONES: Record<string, Tone> = {
  // Opportunity
  lead: 'neutral',
  qualified: 'info',
  discovery: 'info',
  diagnosis: 'info',
  solution: 'info',
  proposal_sent: 'warning',
  negotiation: 'warning',
  won: 'success',
  closed: 'neutral',
  lost: 'danger',
  dormant: 'neutral',

  // Proposal / contract
  draft: 'neutral',
  internal_review: 'warning',
  approved: 'info',
  approved_to_send: 'info',
  sent: 'info',
  viewed: 'info',
  partially_signed: 'warning',
  fully_executed: 'success',
  accepted: 'success',
  rejected: 'danger',
  declined: 'danger',
  expired: 'danger',
  voided: 'neutral',
  withdrawn: 'neutral',
  superseded: 'neutral',

  // Project / task
  not_started: 'neutral',
  active: 'success',
  on_hold: 'warning',
  delivered: 'success',
  cancelled: 'neutral',
  todo: 'neutral',
  in_progress: 'info',

  // Renewal
  upcoming: 'warning',
  auto_renewed: 'success',
  not_renewing: 'neutral',
  blocked: 'danger',
  in_review: 'warning',
  done: 'success',

  // Health
  on_track: 'success',
  at_risk: 'warning',
  off_track: 'danger',
  healthy: 'success',
  watch: 'warning',
  critical: 'danger',
  unknown: 'neutral',
  achieved: 'success',
  missed: 'danger',

  // Onboarding
  ready: 'info',
  complete: 'success',

  // Finance
  issued: 'info',
  partially_paid: 'warning',
  paid: 'success',
  overdue: 'danger',
  satisfied: 'success',
  pending: 'neutral',
  waived: 'neutral',
  received: 'success',
  cleared: 'success',
  failed: 'danger',
};

export function statusTone(status: string): Tone {
  return TONES[status] ?? 'neutral';
}

export function statusLabel(status: string): string {
  return status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant={statusTone(status)} className={className}>
      {statusLabel(status)}
    </Badge>
  );
}
