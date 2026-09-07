'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Circle, Pencil } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { formatMoney } from '@/lib/util/format';

interface Contact {
  id: string;
  full_name: string;
  contact_role: string;
}

/**
 * Qualification evidence.
 *
 * These three fields are what the `qualified` guard requires, so the panel shows
 * them as a checklist with the guard's own wording. A user who cannot advance a
 * deal should be able to see why at a glance, rather than discovering it from an
 * error after clicking.
 */
export function QualificationPanel({
  opportunityId,
  stage,
  businessProblem,
  budgetIndication,
  budgetCurrency,
  decisionMakerId,
  decisionMakerName,
  companyId,
  canEdit,
}: {
  opportunityId: string;
  stage: string;
  businessProblem: string | null;
  budgetIndication: string | null;
  budgetCurrency: string | null;
  decisionMakerId: string | null;
  decisionMakerName: string | null;
  companyId: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [contacts, setContacts] = React.useState<Contact[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const [problem, setProblem] = React.useState(businessProblem ?? '');
  const [budget, setBudget] = React.useState(budgetIndication ?? '');
  const [decisionMaker, setDecisionMaker] = React.useState(decisionMakerId ?? '');

  React.useEffect(() => {
    if (!editing) return;
    void fetch(`/api/v1/contacts?company_id=${companyId}&page_size=100`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((body: { data: Contact[] }) => setContacts(body.data));
  }, [editing, companyId]);

  const hasProblem = (businessProblem ?? '').trim().length >= 10;
  const hasBudget = budgetIndication !== null && budgetIndication !== '';
  const hasDecisionMaker = Boolean(decisionMakerId);
  const complete = hasProblem && hasBudget && hasDecisionMaker;

  const save = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/opportunities/${opportunityId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          business_problem: problem.trim() || null,
          budget_indication: budget.trim() || null,
          budget_currency: budget.trim() ? (budgetCurrency ?? 'USD') : null,
          decision_maker_contact_id: decisionMaker || null,
        }),
      });

      const body = (await response.json()) as { error?: { message: string }; request_id: string };

      if (!response.ok) {
        setError(`${body.error?.message ?? 'Could not save.'} (${body.request_id})`);
        return;
      }

      toast.success('Qualification updated');
      setEditing(false);
      router.refresh();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className={complete ? undefined : 'border-[hsl(var(--warning))]/40'}>
      <CardHeader className="flex-row items-start justify-between">
        <div>
          <CardTitle>Qualification</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {complete
              ? 'This deal has everything needed to advance.'
              : stage === 'lead'
                ? 'All three are required before this deal can be qualified.'
                : 'Some qualification detail is missing.'}
          </p>
        </div>
        {canEdit && !editing ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
        ) : null}
      </CardHeader>

      <CardContent>
        {editing ? (
          <div className="space-y-4">
            {error ? (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="business_problem" required>
                Business problem
              </Label>
              <Textarea
                id="business_problem"
                value={problem}
                onChange={(e) => setProblem(e.target.value)}
                rows={3}
                placeholder="What is going wrong for them, in their words."
              />
              <p className="text-xs text-muted-foreground">
                At least 10 characters. This is the anchor for discovery and the proposal.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="budget_indication" required>
                  Budget indication
                </Label>
                <Input
                  id="budget_indication"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  inputMode="decimal"
                  placeholder="40000.00"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="decision_maker" required>
                  Decision maker
                </Label>
                <select
                  id="decision_maker"
                  value={decisionMaker}
                  onChange={(e) => setDecisionMaker(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Select a contact…</option>
                  {contacts.map((contact) => (
                    <option key={contact.id} value={contact.id}>
                      {contact.full_name}
                      {contact.contact_role !== 'other'
                        ? ` (${contact.contact_role.replace(/_/g, ' ')})`
                        : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={() => void save()} loading={loading}>
                Save
              </Button>
              <Button variant="outline" onClick={() => setEditing(false)} disabled={loading}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <ul className="space-y-3">
            <Requirement met={hasProblem} label="Business problem">
              {businessProblem ?? 'Not recorded'}
            </Requirement>
            <Requirement met={hasBudget} label="Budget indication">
              {hasBudget
                ? formatMoney(budgetIndication!, budgetCurrency ?? 'USD')
                : 'Not recorded'}
            </Requirement>
            <Requirement met={hasDecisionMaker} label="Decision maker">
              {decisionMakerName ?? 'Not identified'}
            </Requirement>
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Requirement({
  met,
  label,
  children,
}: {
  met: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2.5">
      {met ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--success))]" aria-hidden />
      ) : (
        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
          <span className="sr-only">{met ? ': provided' : ': missing'}</span>
        </p>
        <p className={met ? 'mt-0.5 text-sm' : 'mt-0.5 text-sm text-muted-foreground'}>
          {children}
        </p>
      </div>
    </li>
  );
}
