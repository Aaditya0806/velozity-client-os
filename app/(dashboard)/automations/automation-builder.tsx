'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, Loader2, Zap, Filter, PlayCircle, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';
import { EVENT_NAMES, RENEWAL_EVENT_NAMES } from '@/lib/events/types';
import { CONDITION_OPERATORS, type ActionType } from '@/lib/automation/actions';
import {
  ACTION_SPECS,
  ORDERED_ACTIONS,
  OPERATOR_LABELS,
  VALUELESS_OPERATORS,
  type FieldSpec,
} from '@/lib/automation/builder-meta';

interface ConditionDraft {
  path: string;
  op: string;
  value: string;
}

interface ActionDraft {
  type: ActionType;
  params: Record<string, unknown>;
}

export interface AutomationDraft {
  id?: string;
  name: string;
  description: string;
  trigger_event: string;
  conditions: ConditionDraft[];
  actions: ActionDraft[];
  cooldown_seconds: number;
  max_depth: number;
}

const ALL_EVENTS = [...EVENT_NAMES, ...RENEWAL_EVENT_NAMES].sort();

const EMPTY: AutomationDraft = {
  name: '',
  description: '',
  trigger_event: 'opportunity.won',
  conditions: [],
  actions: [],
  cooldown_seconds: 60,
  max_depth: 5,
};

/**
 * Builds a WHEN → IF → THEN automation.
 *
 * The form is generated from the same enumerations the engine validates
 * against, so it cannot offer an action or an operator the server would reject.
 * That is the whole point of building it this way rather than hand-writing the
 * fields: a closed action list is only a guarantee if the UI cannot invent a
 * twelfth one.
 */
export function AutomationBuilder({
  open,
  onOpenChange,
  initial,
  users,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: AutomationDraft;
  users: Array<{ id: string; full_name: string }>;
}) {
  const router = useRouter();
  const [draft, setDraft] = React.useState<AutomationDraft>(initial ?? EMPTY);
  const [saving, setSaving] = React.useState(false);
  const [errors, setErrors] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (open) {
      setDraft(initial ?? EMPTY);
      setErrors([]);
    }
  }, [open, initial]);

  const patch = (changes: Partial<AutomationDraft>) =>
    setDraft((current) => ({ ...current, ...changes }));

  const addAction = (type: ActionType) => {
    const spec = ACTION_SPECS[type];
    const params: Record<string, unknown> = {};
    for (const field of spec.fields) {
      if (field.default !== undefined) params[field.key] = field.default;
    }
    patch({ actions: [...draft.actions, { type, params }] });
  };

  const setActionParam = (index: number, key: string, value: unknown) =>
    patch({
      actions: draft.actions.map((action, i) =>
        i === index ? { ...action, params: { ...action.params, [key]: value } } : action,
      ),
    });

  /**
   * Client-side checks, mirroring the server's schema.
   *
   * The server is authoritative and revalidates everything. This exists so the
   * common mistakes are caught before a round trip, not so the server can trust
   * the input.
   */
  const validate = (): string[] => {
    const found: string[] = [];
    if (!draft.name.trim()) found.push('Give the automation a name.');
    if (draft.actions.length === 0) found.push('An automation needs at least one action.');

    draft.actions.forEach((action, index) => {
      for (const field of ACTION_SPECS[action.type].fields) {
        if (!field.required) continue;
        const value = action.params[field.key];
        if (value === undefined || value === null || value === '') {
          found.push(`Action ${index + 1} (${ACTION_SPECS[action.type].label}): ${field.label} is required.`);
        }
      }
    });

    draft.conditions.forEach((condition, index) => {
      if (!condition.path.trim()) found.push(`Condition ${index + 1} needs a field path.`);
      const needsValue = !VALUELESS_OPERATORS.includes(
        condition.op as (typeof VALUELESS_OPERATORS)[number],
      );
      if (needsValue && condition.value.trim() === '') {
        found.push(`Condition ${index + 1} needs a value.`);
      }
    });

    return found;
  };

  const save = async () => {
    const problems = validate();
    setErrors(problems);
    if (problems.length > 0) return;

    setSaving(true);
    try {
      const payload = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        trigger_event: draft.trigger_event,
        trigger_filter: {},
        conditions: draft.conditions.map((condition) => ({
          path: condition.path.trim(),
          op: condition.op,
          ...(VALUELESS_OPERATORS.includes(condition.op as (typeof VALUELESS_OPERATORS)[number])
            ? {}
            : { value: coerce(condition.value) }),
        })),
        actions: draft.actions,
        cooldown_seconds: draft.cooldown_seconds,
        max_depth: draft.max_depth,
      };

      const response = await fetch(
        draft.id ? `/api/v1/automations/${draft.id}` : '/api/v1/automations',
        {
          method: draft.id ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );

      const body = (await response.json()) as {
        error?: { message: string; details?: { issues?: Array<{ path: string; message: string }> } };
      };

      if (!response.ok) {
        const issues = body.error?.details?.issues;
        setErrors(
          issues?.length
            ? issues.map((issue) => `${issue.path}: ${issue.message}`)
            : [body.error?.message ?? 'That could not be saved.'],
        );
        return;
      }

      toast.success(
        draft.id ? 'Automation updated' : 'Automation created — switch it on when you are ready',
      );
      onOpenChange(false);
      router.refresh();
    } catch {
      setErrors(['Could not reach the server. Please try again.']);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogTitle>{draft.id ? 'Edit automation' : 'New automation'}</DialogTitle>

        <div className="mt-4 space-y-6">
          {/* ------------------------------------------------------- basics */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="automation-name">Name</Label>
              <Input
                id="automation-name"
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="Notify legal when a deal is won"
              />
            </div>
            <div>
              <Label htmlFor="automation-description">Description</Label>
              <Input
                id="automation-description"
                value={draft.description}
                onChange={(e) => patch({ description: e.target.value })}
                placeholder="Optional"
              />
            </div>
          </div>

          {/* ---------------------------------------------------------- WHEN */}
          <section className="rounded-xl border p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Zap className="h-4 w-4 text-brand-500" aria-hidden />
              When
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              The event that starts this automation.
            </p>
            <select
              value={draft.trigger_event}
              onChange={(e) => patch({ trigger_event: e.target.value })}
              className="mt-2 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Trigger event"
            >
              {ALL_EVENTS.map((event) => (
                <option key={event} value={event}>
                  {event}
                </option>
              ))}
            </select>
          </section>

          {/* ------------------------------------------------------------ IF */}
          <section className="rounded-xl border p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Filter className="h-4 w-4 text-brand-500" aria-hidden />
                  If
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  All conditions must hold. Leave empty to run every time.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  patch({
                    conditions: [...draft.conditions, { path: '', op: 'eq', value: '' }],
                  })
                }
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Condition
              </Button>
            </div>

            {draft.conditions.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {draft.conditions.map((condition, index) => {
                  const valueless = VALUELESS_OPERATORS.includes(
                    condition.op as (typeof VALUELESS_OPERATORS)[number],
                  );
                  return (
                    <li key={index} className="flex flex-wrap items-center gap-2">
                      <Input
                        value={condition.path}
                        onChange={(e) =>
                          patch({
                            conditions: draft.conditions.map((c, i) =>
                              i === index ? { ...c, path: e.target.value } : c,
                            ),
                          })
                        }
                        placeholder="opportunity.amount"
                        className="min-w-[12rem] flex-1 font-mono text-xs"
                        aria-label={`Condition ${index + 1} field`}
                      />
                      <select
                        value={condition.op}
                        onChange={(e) =>
                          patch({
                            conditions: draft.conditions.map((c, i) =>
                              i === index ? { ...c, op: e.target.value } : c,
                            ),
                          })
                        }
                        className="rounded-lg border bg-background px-2.5 py-2 text-sm"
                        aria-label={`Condition ${index + 1} operator`}
                      >
                        {CONDITION_OPERATORS.map((op) => (
                          <option key={op} value={op}>
                            {OPERATOR_LABELS[op] ?? op}
                          </option>
                        ))}
                      </select>
                      {!valueless ? (
                        <Input
                          value={condition.value}
                          onChange={(e) =>
                            patch({
                              conditions: draft.conditions.map((c, i) =>
                                i === index ? { ...c, value: e.target.value } : c,
                              ),
                            })
                          }
                          placeholder="Value"
                          className="min-w-[8rem] flex-1"
                          aria-label={`Condition ${index + 1} value`}
                        />
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          patch({ conditions: draft.conditions.filter((_, i) => i !== index) })
                        }
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                        <span className="sr-only">Remove condition {index + 1}</span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>

          {/* ---------------------------------------------------------- THEN */}
          <section className="rounded-xl border p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <PlayCircle className="h-4 w-4 text-brand-500" aria-hidden />
              Then
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Actions run in order. There is no “send email” action anywhere in this list:
              email is drafted for a person to approve, never sent by an automation.
            </p>

            <div className="mt-3 space-y-3">
              {draft.actions.map((action, index) => {
                const spec = ACTION_SPECS[action.type];
                return (
                  <div key={index} className="rounded-lg border bg-muted/30 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {index + 1}. {spec.label}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{spec.description}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          patch({ actions: draft.actions.filter((_, i) => i !== index) })
                        }
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                        <span className="sr-only">Remove action {index + 1}</span>
                      </Button>
                    </div>

                    {spec.fields.length > 0 ? (
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        {spec.fields.map((field) => (
                          <ActionField
                            key={field.key}
                            field={field}
                            index={index}
                            value={action.params[field.key]}
                            users={users}
                            onChange={(value) => setActionParam(index, field.key, value)}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {ORDERED_ACTIONS.map((spec) => (
                <Button
                  key={spec.type}
                  size="sm"
                  variant="outline"
                  onClick={() => addAction(spec.type)}
                  disabled={draft.actions.length >= 10}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  {spec.label}
                </Button>
              ))}
            </div>
            {draft.actions.length >= 10 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Ten actions is the limit. An automation longer than that is usually two.
              </p>
            ) : null}
          </section>

          {/* ------------------------------------------------------ guardrails */}
          <section className="rounded-xl border p-4">
            <h3 className="text-sm font-semibold">Loop protection</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              An automation can trigger events that trigger automations. These two limits are
              what stop that becoming infinite, and they are enforced by the engine.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="cooldown">Cooldown per record (seconds)</Label>
                <Input
                  id="cooldown"
                  type="number"
                  min={0}
                  max={86400}
                  value={draft.cooldown_seconds}
                  onChange={(e) => patch({ cooldown_seconds: Number(e.target.value) })}
                />
              </div>
              <div>
                <Label htmlFor="depth">Maximum chain depth</Label>
                <Input
                  id="depth"
                  type="number"
                  min={1}
                  max={5}
                  value={draft.max_depth}
                  onChange={(e) => patch({ max_depth: Number(e.target.value) })}
                />
              </div>
            </div>
          </section>

          {errors.length > 0 ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" aria-hidden />
                Not saved
              </p>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm text-destructive">
                {errors.map((error, i) => (
                  <li key={i}>{error}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <Badge variant="neutral">
              {draft.id ? 'Changes apply on save' : 'Created switched off'}
            </Badge>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                {draft.id ? 'Save changes' : 'Create automation'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Renders one action parameter according to its spec. */
function ActionField({
  field,
  index,
  value,
  users,
  onChange,
}: {
  field: FieldSpec;
  index: number;
  value: unknown;
  users: Array<{ id: string; full_name: string }>;
  onChange: (value: unknown) => void;
}) {
  const id = `action-${index}-${field.key}`;
  const options = field.key === 'user_id' ? users.map((u) => u.id) : field.options;

  return (
    <div className={field.kind === 'textarea' ? 'sm:col-span-2' : undefined}>
      <Label htmlFor={id}>
        {field.label}
        {field.required ? <span aria-hidden> *</span> : null}
      </Label>

      {field.kind === 'select' ? (
        <select
          id={id}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">Choose…</option>
          {(options ?? []).map((option) => (
            <option key={option} value={option}>
              {field.key === 'user_id'
                ? (users.find((u) => u.id === option)?.full_name ?? option)
                : option}
            </option>
          ))}
        </select>
      ) : field.kind === 'textarea' ? (
        <textarea
          id={id}
          rows={3}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full resize-y rounded-lg border bg-background p-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : field.kind === 'boolean' ? (
        <label className="mt-1 flex items-center gap-2 text-sm">
          <input
            id={id}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          {field.hint ?? 'Enabled'}
        </label>
      ) : (
        <Input
          id={id}
          type={field.kind === 'number' ? 'number' : 'text'}
          value={String(value ?? '')}
          placeholder={field.placeholder}
          onChange={(e) =>
            onChange(field.kind === 'number' ? Number(e.target.value) : e.target.value)
          }
        />
      )}

      {field.hint && field.kind !== 'boolean' ? (
        <p className="mt-1 text-xs text-muted-foreground">{field.hint}</p>
      ) : null}
    </div>
  );
}

/**
 * Turns a typed-in condition value into the type it looks like.
 *
 * `amount > "10000"` compares strings and quietly gives the wrong answer, so a
 * numeric-looking value becomes a number and a boolean-looking one a boolean.
 * Everything else stays a string.
 */
function coerce(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed);
  if (trimmed.includes(',')) return trimmed.split(',').map((part) => part.trim());
  return trimmed;
}
