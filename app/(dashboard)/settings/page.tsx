import type { Metadata } from 'next';
import { requireContext, query } from '@/lib/auth/session';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { SYSTEM_ROLE_LABELS, type SystemRoleKey } from '@/lib/permissions';
import { formatRelative } from '@/lib/util/format';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const ctx = await requireContext();

  const members = ctx.permissions.has('user:read:org')
    ? await query(
        ctx,
        (tx) =>
          tx.many<Record<string, unknown>>(
            `select u.id, u.full_name, u.email, u.status, u.last_seen_at,
                    m.is_owner,
                    array_remove(array_agg(r.key order by r.rank), null) as role_keys
             from org_memberships m
             join user_profiles u on u.id = m.user_id
             left join user_roles ur on ur.user_id = u.id and ur.org_id = m.org_id
             left join roles r on r.id = ur.role_id
             where m.deleted_at is null and u.deleted_at is null
             group by u.id, u.full_name, u.email, u.status, u.last_seen_at, m.is_owner
             order by u.full_name`,
          ),
        { readOnly: true },
      )
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Your organisation, its people and your own access."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Organisation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 text-sm">
            <Row label="Name">{ctx.org.name}</Row>
            <Row label="Identifier">
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {ctx.org.slug}
              </code>
            </Row>
            <Row label="Base currency">{ctx.org.baseCurrency}</Row>
            <Row label="Business timezone">{ctx.org.timezone}</Row>
            <Row label="AI">
              <Badge variant={ctx.org.aiEnabled ? 'success' : 'neutral'}>
                {ctx.org.aiEnabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Your access</CardTitle>
            <CardDescription>
              What the server will allow you to do. The interface hides what you cannot reach,
              but this list is the authority.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {ctx.roleKeys.length === 0 ? (
                <Badge variant="warning">No role assigned</Badge>
              ) : (
                ctx.roleKeys.map((role) => (
                  <Badge key={role} variant="info">
                    {SYSTEM_ROLE_LABELS[role as SystemRoleKey] ?? role}
                  </Badge>
                ))
              )}
              {ctx.isOwner ? <Badge variant="success">Owner</Badge> : null}
            </div>

            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                {ctx.permissions.toArray().length} permissions
              </summary>
              <ul className="scrollbar-thin mt-2 max-h-56 space-y-0.5 overflow-y-auto">
                {ctx.permissions.toArray().map((permission) => (
                  <li key={permission}>
                    <code className="font-mono text-2xs text-muted-foreground">{permission}</code>
                  </li>
                ))}
              </ul>
            </details>
          </CardContent>
        </Card>
      </div>

      {ctx.permissions.has('user:read:org') ? (
        <Card>
          <CardHeader>
            <CardTitle>People</CardTitle>
            <CardDescription>{members.length} in this organisation.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {members.map((member) => {
                const roles = (member.role_keys as string[]) ?? [];
                return (
                  <li
                    key={String(member.id)}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {String(member.full_name) || String(member.email)}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {String(member.email)}
                        {member.last_seen_at
                          ? ` · last seen ${formatRelative(member.last_seen_at as string)}`
                          : ' · never signed in'}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      {member.is_owner ? <Badge variant="success">Owner</Badge> : null}
                      {roles.map((role) => (
                        <Badge key={role} variant="neutral">
                          {SYSTEM_ROLE_LABELS[role as SystemRoleKey] ?? role}
                        </Badge>
                      ))}
                      <StatusBadge status={String(member.status)} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}
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
