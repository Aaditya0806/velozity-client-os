'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Pencil, Power, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast';
import { AutomationBuilder, type AutomationDraft } from './automation-builder';

export interface AutomationSummary {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  trigger_event: string;
  conditions: Array<{ path: string; op: string; value?: unknown }>;
  actions: Array<{ type: string; params: Record<string, unknown> }>;
  cooldown_seconds: number;
  max_depth: number;
}

/** The "New automation" button, and the builder it opens. */
export function NewAutomationButton({ users }: { users: Array<{ id: string; full_name: string }> }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden />
        New automation
      </Button>
      <AutomationBuilder open={open} onOpenChange={setOpen} users={users} />
    </>
  );
}

/**
 * Edit, switch on or off, and delete — for one automation.
 *
 * Activation is its own button rather than a field inside the editor, because
 * "change what this does" and "let this start doing it" are different decisions
 * and the audit trail records them separately.
 */
export function AutomationRowControls({
  automation,
  users,
}: {
  automation: AutomationSummary;
  users: Array<{ id: string; full_name: string }>;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const draft: AutomationDraft = {
    id: automation.id,
    name: automation.name,
    description: automation.description ?? '',
    trigger_event: automation.trigger_event,
    conditions: automation.conditions.map((condition) => ({
      path: condition.path,
      op: condition.op,
      value: condition.value === undefined || condition.value === null
        ? ''
        : Array.isArray(condition.value)
          ? condition.value.join(', ')
          : String(condition.value),
    })),
    actions: automation.actions as AutomationDraft['actions'],
    cooldown_seconds: automation.cooldown_seconds,
    max_depth: automation.max_depth,
  };

  const toggle = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/automations/${automation.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ is_active: !automation.is_active }),
      });
      if (!response.ok) {
        toast.error('That could not be changed.');
        return;
      }
      toast.success(
        automation.is_active
          ? `"${automation.name}" is paused`
          : `"${automation.name}" is now live`,
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/automations/${automation.id}`, { method: 'DELETE' });
      if (!response.ok) {
        toast.error('That could not be deleted.');
        return;
      }
      toast.success(`Deleted "${automation.name}"`);
      setConfirmDelete(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant={automation.is_active ? 'outline' : 'secondary'}
          size="sm"
          onClick={() => void toggle()}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Power className="h-3.5 w-3.5" aria-hidden />
          )}
          {automation.is_active ? 'Pause' : 'Switch on'}
        </Button>

        <Button variant="ghost" size="icon-sm" onClick={() => setEditing(true)} title="Edit">
          <Pencil className="h-4 w-4" aria-hidden />
          <span className="sr-only">Edit {automation.name}</span>
        </Button>

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setConfirmDelete(true)}
          title="Delete"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
          <span className="sr-only">Delete {automation.name}</span>
        </Button>
      </div>

      <AutomationBuilder
        open={editing}
        onOpenChange={setEditing}
        initial={draft}
        users={users}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${automation.name}"?`}
        description="Its run history is kept, so past runs remain explainable. The automation stops immediately."
        confirmLabel="Delete"
        destructive
        loading={busy}
        onConfirm={() => void remove()}
      />
    </>
  );
}
