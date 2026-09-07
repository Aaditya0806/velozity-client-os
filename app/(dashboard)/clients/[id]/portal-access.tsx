'use client';

import * as React from 'react';
import { UserPlus, Loader2, Copy, ShieldOff, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast';
import { formatDate } from '@/lib/util/format';

interface PortalUser {
  id: string;
  status: string;
  contact_id: string;
  contact_name: string;
  contact_email: string;
  can_view_invoices: boolean;
  can_view_documents: boolean;
  can_approve_deliverables: boolean;
  invited_at: string | null;
  last_login_at: string | null;
}

interface Contact {
  id: string;
  full_name: string;
  email: string | null;
}

const CAPABILITIES = [
  { key: 'can_view_documents', label: 'Documents', hint: 'Files shared with them' },
  { key: 'can_view_invoices', label: 'Invoices', hint: 'Issued invoices and balances' },
  {
    key: 'can_approve_deliverables',
    label: 'Approve deliverables',
    hint: 'Accept or request changes',
  },
] as const;

type CapabilityKey = (typeof CAPABILITIES)[number]['key'];

/**
 * Who at this client can sign in, and what they see.
 *
 * The capability switches are the same three columns the portal projections and
 * the `app.portal_*` functions read, so what this panel shows is what the
 * database will actually enforce — not a second, drifting copy of the rule.
 */
export function PortalAccess({ clientId, canManage }: { clientId: string; canManage: boolean }) {
  const [users, setUsers] = React.useState<PortalUser[] | null>(null);
  const [contacts, setContacts] = React.useState<Contact[]>([]);
  const [inviting, setInviting] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<PortalUser | null>(null);
  const [inviteLink, setInviteLink] = React.useState<string | null>(null);

  const [form, setForm] = React.useState<{
    contact_id: string;
    can_view_documents: boolean;
    can_view_invoices: boolean;
    can_approve_deliverables: boolean;
  }>({
    contact_id: '',
    can_view_documents: true,
    can_view_invoices: false,
    can_approve_deliverables: false,
  });

  const load = React.useCallback(async () => {
    const response = await fetch(`/api/v1/clients/${clientId}/portal-users`);
    if (response.ok) {
      const body = (await response.json()) as { data: { portal_users: PortalUser[] } };
      setUsers(body.data.portal_users);
    } else {
      setUsers([]);
    }
  }, [clientId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const openInvite = async () => {
    setInviting(true);
    const response = await fetch(`/api/v1/contacts?company_id=${clientId}&page_size=100`);
    if (response.ok) {
      const body = (await response.json()) as { data: Contact[] };
      setContacts(body.data ?? []);
    }
  };

  const grant = async () => {
    if (!form.contact_id) return;
    setBusyId('new');
    try {
      const response = await fetch(`/api/v1/clients/${clientId}/portal-users`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const body = (await response.json()) as {
        data?: { invite_link: string | null };
        error?: { message: string };
      };

      if (!response.ok) {
        toast.error(body.error?.message ?? 'Access could not be granted.');
        return;
      }

      toast.success('Portal access granted');
      setInviteLink(body.data?.invite_link ?? null);
      setInviting(false);
      setForm({
        contact_id: '',
        can_view_documents: true,
        can_view_invoices: false,
        can_approve_deliverables: false,
      });
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const toggle = async (user: PortalUser, key: CapabilityKey) => {
    setBusyId(user.id);
    const next = {
      can_view_invoices: user.can_view_invoices,
      can_view_documents: user.can_view_documents,
      can_approve_deliverables: user.can_approve_deliverables,
      [key]: !user[key],
    };
    try {
      const response = await fetch(`/api/v1/clients/${clientId}/portal-users/${user.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!response.ok) {
        toast.error('That change could not be saved.');
        return;
      }
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    setBusyId(revoking.id);
    try {
      const response = await fetch(`/api/v1/clients/${clientId}/portal-users/${revoking.id}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        toast.error('Access could not be revoked.');
        return;
      }
      toast.success(`Revoked access for ${revoking.contact_name}`);
      setRevoking(null);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const active = (users ?? []).filter((u) => u.status !== 'revoked');
  const revoked = (users ?? []).filter((u) => u.status === 'revoked');

  if (users === null) {
    return <p className="p-6 text-sm text-muted-foreground">Loading portal access…</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">Portal access</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            People at this client who can sign in and see their own work.
          </p>
        </div>
        {canManage ? (
          <Button size="sm" onClick={() => void openInvite()}>
            <UserPlus className="h-4 w-4" aria-hidden />
            Grant access
          </Button>
        ) : null}
      </div>

      {active.length === 0 ? (
        <EmptyState
          icon={UserPlus}
          title="Nobody has portal access"
          description="Grant a contact access and they can follow their projects, documents and invoices themselves."
        />
      ) : (
        <ul className="divide-y rounded-xl border">
          {active.map((user) => (
            <li key={user.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{user.contact_name}</p>
                <p className="truncate text-sm text-muted-foreground">{user.contact_email}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {user.last_login_at
                    ? `Last signed in ${formatDate(user.last_login_at)}`
                    : user.invited_at
                      ? `Invited ${formatDate(user.invited_at)} · not signed in yet`
                      : 'Never signed in'}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {CAPABILITIES.map((capability) => {
                  const on = user[capability.key];
                  return (
                    <button
                      key={capability.key}
                      type="button"
                      disabled={!canManage || busyId === user.id}
                      title={capability.hint}
                      onClick={() => void toggle(user, capability.key)}
                      className={[
                        'rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                        on
                          ? 'border-brand-500/40 bg-brand-500/10 text-brand-700 dark:text-brand-300'
                          : 'text-muted-foreground hover:bg-accent',
                        canManage ? '' : 'cursor-default',
                      ].join(' ')}
                      aria-pressed={on}
                    >
                      {on ? <Check className="mr-1 inline h-3 w-3" aria-hidden /> : null}
                      {capability.label}
                    </button>
                  );
                })}
              </div>

              <Badge variant={user.status === 'active' ? 'success' : 'warning'}>
                {user.status}
              </Badge>

              {canManage ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Revoke access"
                  onClick={() => setRevoking(user)}
                  disabled={busyId === user.id}
                >
                  {busyId === user.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <ShieldOff className="h-4 w-4" aria-hidden />
                  )}
                  <span className="sr-only">Revoke access for {user.contact_name}</span>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {revoked.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Previously had access
          </p>
          <ul className="mt-2 space-y-1">
            {revoked.map((user) => (
              <li key={user.id} className="text-sm text-muted-foreground">
                {user.contact_name} · {user.contact_email}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ------------------------------------------------------------- grant */}
      <Dialog open={inviting} onOpenChange={setInviting}>
        <DialogContent className="max-w-lg">
          <DialogTitle>Grant portal access</DialogTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            They receive a link to choose their own password. No password is set for them.
          </p>

          <label className="mt-4 block text-sm font-medium" htmlFor="portal-contact">
            Contact
          </label>
          <select
            id="portal-contact"
            value={form.contact_id}
            onChange={(e) => setForm((f) => ({ ...f, contact_id: e.target.value }))}
            className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Choose a contact…</option>
            {contacts
              .filter((c) => c.email)
              .map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.full_name} — {contact.email}
                </option>
              ))}
          </select>

          <fieldset className="mt-4">
            <legend className="text-sm font-medium">They can see</legend>
            <div className="mt-2 space-y-2">
              {CAPABILITIES.map((capability) => (
                <label key={capability.key} className="flex items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={form[capability.key]}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, [capability.key]: e.target.checked }))
                    }
                  />
                  <span>
                    <span className="font-medium">{capability.label}</span>
                    <span className="block text-xs text-muted-foreground">{capability.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setInviting(false)}>
              Cancel
            </Button>
            <Button onClick={() => void grant()} disabled={!form.contact_id || busyId === 'new'}>
              {busyId === 'new' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Grant access
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* -------------------------------------------------------- invite link */}
      <Dialog open={inviteLink !== null} onOpenChange={() => setInviteLink(null)}>
        <DialogContent className="max-w-lg">
          <DialogTitle>Send them this link</DialogTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            It lets them set a password once. Send it the way you normally reach them — it is not
            emailed automatically.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              readOnly
              value={inviteLink ?? ''}
              className="w-full rounded-lg border bg-muted px-3 py-2 font-mono text-xs"
              aria-label="Invitation link"
            />
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(inviteLink ?? '');
                toast.success('Link copied');
              }}
            >
              <Copy className="h-4 w-4" aria-hidden />
              Copy
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke access for ${revoking?.contact_name ?? ''}?`}
        description="They will be signed out and will not be able to sign in again. The record of their access is kept."
        confirmLabel="Revoke access"
        destructive
        onConfirm={() => void revoke()}
      />
    </div>
  );
}
