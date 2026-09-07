'use client';

import * as React from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  Users, GitBranch, Package, FolderKanban, CheckSquare, FileText, Scale,
  Mail, BarChart3, Wallet, History, LayoutGrid,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { formatMoney, formatDate, formatRelative } from '@/lib/util/format';
import { ClientTimeline } from './client-timeline';
import { ClientBilling } from './client-billing';

interface Overview {
  company: Record<string, unknown>;
  contacts: Array<Record<string, unknown>>;
  pipeline: {
    open_count: string; open_value: string; won_count: string;
    won_value: string; lost_count: string; currency: string | null;
  };
  projects: Array<Record<string, unknown>>;
  contracts: Array<Record<string, unknown>>;
  billing: { invoiced: string; paid: string; outstanding: string; overdue: string } | null;
  upcoming: Array<{ kind: string; label: string; due_on: string }>;
  health: {
    score: number | null;
    status: string | null;
    signals: Array<{ label: string; value: string; tone: string }>;
  };
}

const TABS = [
  { value: 'overview', label: 'Overview', icon: LayoutGrid },
  { value: 'contacts', label: 'Contacts', icon: Users },
  { value: 'pipeline', label: 'Pipeline', icon: GitBranch },
  { value: 'services', label: 'Services', icon: Package },
  { value: 'projects', label: 'Projects', icon: FolderKanban },
  { value: 'tasks', label: 'Tasks', icon: CheckSquare },
  { value: 'documents', label: 'Documents', icon: FileText },
  { value: 'legal', label: 'Legal', icon: Scale },
  { value: 'emails', label: 'Emails', icon: Mail },
  { value: 'reports', label: 'Reports', icon: BarChart3 },
  { value: 'billing', label: 'Billing', icon: Wallet, permission: 'finance:read:org' },
  { value: 'activity', label: 'Activity', icon: History },
] as const;

export function ClientTabs({
  clientId,
  initialTab,
  overview,
  permissions,
  baseCurrency,
  timezone,
}: {
  clientId: string;
  initialTab: string;
  overview: Overview;
  permissions: string[];
  baseCurrency: string;
  timezone: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const held = new Set(permissions);

  const visibleTabs = TABS.filter(
    (tab) => !('permission' in tab) || held.has(tab.permission as string),
  );

  const currency = overview.pipeline.currency ?? baseCurrency;

  const onTabChange = (value: string) => {
    // The tab lives in the URL so a link to a specific tab works.
    router.replace(`${pathname}?tab=${value}`, { scroll: false });
  };

  return (
    <Tabs defaultValue={initialTab} onValueChange={onTabChange}>
      <TabsList>
        {visibleTabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            <span className="flex items-center gap-1.5">
              <tab.icon className="h-3.5 w-3.5" aria-hidden />
              {tab.label}
            </span>
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="overview">
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Open pipeline"
              value={formatMoney(overview.pipeline.open_value, currency, 'en-GB', { compact: true })}
              hint={`${overview.pipeline.open_count} open`}
            />
            <StatCard
              label="Won"
              value={formatMoney(overview.pipeline.won_value, currency, 'en-GB', { compact: true })}
              hint={`${overview.pipeline.won_count} deals`}
              tone="success"
            />
            <StatCard
              label="Active projects"
              value={String(
                overview.projects.filter((p) => p.status === 'active').length,
              )}
              hint={`${overview.projects.length} total`}
            />
            {overview.billing ? (
              <StatCard
                label="Outstanding"
                value={formatMoney(overview.billing.outstanding, currency, 'en-GB', { compact: true })}
                hint={
                  Number.parseFloat(overview.billing.overdue) > 0
                    ? `${formatMoney(overview.billing.overdue, currency, 'en-GB', { compact: true })} overdue`
                    : 'Nothing overdue'
                }
                tone={Number.parseFloat(overview.billing.overdue) > 0 ? 'danger' : 'default'}
              />
            ) : (
              <StatCard
                label="Contracts"
                value={String(overview.contracts.length)}
                hint={`${overview.contracts.filter((c) => c.status === 'fully_executed').length} executed`}
              />
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Company</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5 text-sm">
                <Detail label="Legal name" value={overview.company.legal_name} />
                <Detail label="Industry" value={overview.company.industry} />
                <Detail label="Website" value={overview.company.website} link />
                <Detail label="Owner" value={overview.company.owner_name} />
                <Detail label="Country" value={overview.company.country} />
                <Detail
                  label="Client since"
                  value={formatDate(overview.company.created_at as string)}
                />
                {'internal_notes' in overview.company && overview.company.internal_notes ? (
                  <div className="border-t pt-2.5">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Internal notes
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm">
                      {String(overview.company.internal_notes)}
                    </p>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Health</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {overview.health.signals.map((signal) => (
                  <div key={signal.label} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{signal.label}</span>
                    <span
                      className={
                        signal.tone === 'good'
                          ? 'font-medium text-[hsl(var(--success))]'
                          : signal.tone === 'warn'
                            ? 'font-medium text-[hsl(var(--warning))]'
                            : signal.tone === 'bad'
                              ? 'font-medium text-destructive'
                              : 'font-medium text-muted-foreground'
                      }
                    >
                      {signal.value}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Coming up</CardTitle>
              </CardHeader>
              <CardContent>
                {overview.upcoming.length === 0 ? (
                  <p className="py-4 text-sm text-muted-foreground">
                    Nothing scheduled in the next 90 days.
                  </p>
                ) : (
                  <ul className="space-y-2.5">
                    {overview.upcoming.slice(0, 8).map((item, index) => (
                      <li key={`${item.kind}-${index}`} className="text-sm">
                        <p className="truncate">{item.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(item.due_on)} · {formatRelative(item.due_on)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </TabsContent>

      <TabsContent value="contacts">
        {overview.contacts.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No contacts yet"
            description="Add the people you deal with so proposals and contracts know who to address."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {overview.contacts.map((contact) => (
              <Card key={String(contact.id)}>
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{String(contact.full_name)}</p>
                      {contact.job_title ? (
                        <p className="truncate text-sm text-muted-foreground">
                          {String(contact.job_title)}
                        </p>
                      ) : null}
                    </div>
                    {contact.is_primary ? <Badge variant="info">Primary</Badge> : null}
                  </div>
                  <div className="mt-3 space-y-1 text-sm">
                    {contact.email ? (
                      <a
                        href={`mailto:${String(contact.email)}`}
                        className="block truncate text-primary hover:underline"
                      >
                        {String(contact.email)}
                      </a>
                    ) : null}
                    {contact.phone ? (
                      <p className="text-muted-foreground">{String(contact.phone)}</p>
                    ) : null}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Badge variant="neutral">
                      {String(contact.contact_role).replace(/_/g, ' ')}
                    </Badge>
                    {contact.is_signatory ? <Badge variant="outline">Signatory</Badge> : null}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="pipeline">
        <ClientPipeline clientId={clientId} />
      </TabsContent>

      <TabsContent value="projects">
        {overview.projects.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            title="No projects yet"
            description="A project is created when onboarding completes for a won deal."
          />
        ) : (
          <div className="rounded-lg border divide-y">
            {overview.projects.map((project) => (
              <Link
                key={String(project.id)}
                href={`/projects/${String(project.id)}`}
                className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-accent"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{String(project.name)}</p>
                  <p className="text-xs text-muted-foreground">
                    {String(project.code)} · {formatDate(project.start_date as string)} –{' '}
                    {formatDate(project.target_end_date as string)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <StatusBadge status={String(project.status)} />
                  <StatusBadge status={String(project.health)} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="legal">
        {overview.contracts.length === 0 ? (
          <EmptyState
            icon={Scale}
            title="No contracts yet"
            description="NDAs and agreements appear here as they are drafted, sent and executed."
          />
        ) : (
          <div className="rounded-lg border divide-y">
            {overview.contracts.map((contract) => (
              <Link
                key={String(contract.id)}
                href={`/legal/contracts/${String(contract.id)}`}
                className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-accent"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{String(contract.title)}</p>
                  <p className="text-xs text-muted-foreground">
                    {String(contract.reference)} ·{' '}
                    {String(contract.contract_type).toUpperCase()}
                    {contract.executed_at
                      ? ` · executed ${formatDate(contract.executed_at as string)}`
                      : ''}
                  </p>
                </div>
                <StatusBadge status={String(contract.status)} />
              </Link>
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="documents">
        <ClientDocuments clientId={clientId} />
      </TabsContent>

      <TabsContent value="billing">
        {held.has('finance:read:org') ? (
          <ClientBilling clientId={clientId} currency={currency} />
        ) : null}
      </TabsContent>

      <TabsContent value="activity">
        <ClientTimeline clientId={clientId} timezone={timezone} />
      </TabsContent>

      {['services', 'tasks', 'emails', 'reports'].map((tab) => (
        <TabsContent key={tab} value={tab}>
          <EmptyState
            title={`${tab[0]?.toUpperCase()}${tab.slice(1)} view`}
            description="This panel is part of a later delivery phase. The underlying data already exists and is reachable through the API."
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function Detail({
  label,
  value,
  link = false,
}: {
  label: string;
  value: unknown;
  link?: boolean;
}) {
  const text = value === null || value === undefined || value === '' ? null : String(value);
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {text === null ? (
        <span className="text-muted-foreground">—</span>
      ) : link ? (
        <a
          href={text}
          target="_blank"
          rel="noreferrer noopener"
          className="truncate text-primary hover:underline"
        >
          {text.replace(/^https?:\/\//, '')}
        </a>
      ) : (
        <span className="truncate text-right">{text}</span>
      )}
    </div>
  );
}

function ClientPipeline({ clientId }: { clientId: string }) {
  const [rows, setRows] = React.useState<Array<Record<string, unknown>> | null>(null);

  React.useEffect(() => {
    void fetch(`/api/v1/opportunities?company_id=${clientId}&page_size=50`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((body: { data: Array<Record<string, unknown>> }) => setRows(body.data));
  }, [clientId]);

  if (rows === null) return <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={GitBranch}
        title="No opportunities"
        description="Deals for this client will appear here."
      />
    );
  }

  return (
    <div className="rounded-lg border divide-y">
      {rows.map((row) => (
        <Link
          key={String(row.id)}
          href={`/pipeline/${String(row.id)}`}
          className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-accent"
        >
          <div className="min-w-0">
            <p className="truncate font-medium">{String(row.name)}</p>
            <p className="text-xs text-muted-foreground">{String(row.reference)}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="tabular text-sm">
              {formatMoney(String(row.amount), String(row.currency))}
            </span>
            <StatusBadge status={String(row.stage)} />
          </div>
        </Link>
      ))}
    </div>
  );
}

function ClientDocuments({ clientId }: { clientId: string }) {
  const [rows, setRows] = React.useState<Array<Record<string, unknown>> | null>(null);

  React.useEffect(() => {
    void fetch(`/api/v1/documents?company_id=${clientId}&page_size=50`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((body: { data: Array<Record<string, unknown>> }) => setRows(body.data));
  }, [clientId]);

  if (rows === null) return <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No documents"
        description="Uploaded files and generated contracts appear here."
      />
    );
  }

  return (
    <div className="rounded-lg border divide-y">
      {rows.map((row) => (
        <div key={String(row.id)} className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate font-medium">{String(row.name)}</p>
            <p className="text-xs text-muted-foreground">
              {String(row.category).replace(/_/g, ' ')} ·{' '}
              {formatDate(row.created_at as string)}
              {row.version_no ? ` · v${String(row.version_no)}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {row.is_immutable ? <Badge variant="success">Sealed</Badge> : null}
            {row.is_confidential ? <Badge variant="warning">Confidential</Badge> : null}
            <a
              href={`/api/v1/documents/${String(row.id)}/download`}
              className="text-sm text-primary hover:underline"
            >
              Download
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}
