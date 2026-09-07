import type { Metadata } from 'next';
import { Sparkles, ShieldCheck, KeyRound } from 'lucide-react';
import { requireContext, query } from '@/lib/auth/session';
import { serverEnv } from '@/lib/config/env';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Assistant } from './assistant';
import { PendingActions } from './pending-actions';

export const metadata: Metadata = { title: 'AI' };
export const dynamic = 'force-dynamic';

export default async function AiPage() {
  const ctx = await requireContext();

  if (!ctx.org.aiEnabled) {
    return (
      <div className="space-y-6">
        <PageHeader title="AI" />
        <EmptyState
          icon={Sparkles}
          title="AI is switched off for this organisation"
          description="An administrator can enable it in settings. While it is off, no data from this organisation is sent to a model under any circumstance."
        />
      </div>
    );
  }

  // Read on the server: whether a key exists is an operator fact, and the key
  // itself must never be serialised into a prop.
  const configured = Boolean(serverEnv().ANTHROPIC_API_KEY);

  const pending = ctx.permissions.has('ai:read:org')
    ? await query(
        ctx,
        (tx) =>
          tx.many<Record<string, unknown>>(
            `select a.id, a.action_type, a.entity_type, a.entity_id, a.status,
                    a.proposed_payload, a.model, a.cost_usd, a.requested_at,
                    u.full_name as requested_by_name, c.name as company_name
             from ai_actions a
             left join user_profiles u on u.id = a.requested_by
             left join companies c on c.id = a.company_id
             where a.status = 'pending_approval'
             order by a.requested_at desc
             limit 20`,
          ),
        { readOnly: true },
      )
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI"
        description="Ask questions of your own data, and review anything the model has drafted."
      />

      <Card className="border-primary/30 bg-primary/[0.03]">
        <CardContent className="flex items-start gap-3 p-4">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <div className="text-sm">
            <p className="font-medium">The model reads. People decide.</p>
            <p className="mt-1 text-muted-foreground">
              The assistant answers using a fixed set of read-only tools, restricted to what
              you personally have permission to see. It cannot write to any record. Anything
              it drafts becomes a proposal that a person reviews, edits and approves before it
              takes effect.
            </p>
          </div>
        </CardContent>
      </Card>

      {!configured ? (
        <Card className="border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/[0.04]">
          <CardContent className="flex items-start gap-3 p-4">
            <KeyRound
              className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--warning))]"
              aria-hidden
            />
            <div className="text-sm">
              <p className="font-medium">The assistant needs an Anthropic API key</p>
              <p className="mt-1 text-muted-foreground">
                Create a key at{' '}
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary underline underline-offset-2"
                >
                  console.anthropic.com
                </a>
                , put it in <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">.env</code>{' '}
                as <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">ANTHROPIC_API_KEY</code>,
                then restart the server. Everything else on this page keeps working without it.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {ctx.permissions.has('ai:use:org') ? <Assistant configured={configured} /> : null}

      {ctx.permissions.has('ai:read:org') ? (
        <Card>
          <CardHeader>
            <CardTitle>Awaiting review</CardTitle>
          </CardHeader>
          <CardContent>
            <PendingActions
              actions={JSON.parse(JSON.stringify(pending))}
              canApprove={ctx.permissions.has('ai:approve:org')}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
