'use client';

import * as React from 'react';
import {
  FileText, Mail, Phone, Users, GitBranch, Scale, Wallet, Sparkles,
  Workflow, Plus, RefreshCw, MessageSquare, History, Lock,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime, formatRelative, initialsOf } from '@/lib/util/format';

interface Activity {
  id: string;
  activity_type: string;
  title: string;
  body: string | null;
  is_internal: boolean;
  actor_name: string | null;
  actor_type: string;
  occurred_at: string;
  metadata: Record<string, unknown>;
}

const ICONS: Record<string, LucideIcon> = {
  created: Plus,
  updated: RefreshCw,
  state_changed: GitBranch,
  note: MessageSquare,
  call: Phone,
  meeting: Users,
  email: Mail,
  comment: MessageSquare,
  assignment: Users,
  document: FileText,
  contract: Scale,
  proposal: FileText,
  payment: Wallet,
  system: History,
  ai: Sparkles,
  automation: Workflow,
};

export function ClientTimeline({ clientId, timezone }: { clientId: string; timezone: string }) {
  const [items, setItems] = React.useState<Activity[] | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [exhausted, setExhausted] = React.useState(false);

  const load = React.useCallback(
    async (before?: string) => {
      const url = new URL(`/api/v1/clients/${clientId}/timeline`, window.location.origin);
      url.searchParams.set('limit', '30');
      if (before) url.searchParams.set('before', before);

      const response = await fetch(url.toString());
      if (!response.ok) return [];
      const body = (await response.json()) as { data: Activity[] };
      return body.data;
    },
    [clientId],
  );

  React.useEffect(() => {
    void load().then((rows) => {
      setItems(rows);
      setExhausted(rows.length < 30);
    });
  }, [load]);

  const loadMore = async () => {
    if (!items || items.length === 0) return;
    setLoadingMore(true);
    const oldest = items[items.length - 1]!.occurred_at;
    const rows = await load(oldest);
    setItems((current) => [...(current ?? []), ...rows]);
    setExhausted(rows.length < 30);
    setLoadingMore(false);
  };

  if (items === null) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/4" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="Nothing has happened yet"
        description="Every change to this client is recorded here as it occurs."
      />
    );
  }

  return (
    <div className="space-y-1">
      <ol className="relative space-y-0">
        {items.map((item, index) => {
          const Icon = ICONS[item.activity_type] ?? History;
          const isLast = index === items.length - 1;

          return (
            <li key={item.id} className="relative flex gap-3 pb-6">
              {/* The connecting line, stopped before the final entry. */}
              {!isLast ? (
                <span
                  className="absolute left-4 top-9 h-full w-px -translate-x-1/2 bg-border"
                  aria-hidden
                />
              ) : null}

              <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background">
                <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              </span>

              <div className="min-w-0 flex-1 pt-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <p className="text-sm font-medium">{item.title}</p>
                  {item.is_internal ? (
                    <Badge variant="neutral" className="gap-1">
                      <Lock className="h-2.5 w-2.5" aria-hidden />
                      Internal
                    </Badge>
                  ) : null}
                  {item.actor_type !== 'user' ? (
                    <Badge variant="outline">{item.actor_type}</Badge>
                  ) : null}
                </div>

                {item.body ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                    {item.body}
                  </p>
                ) : null}

                <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {item.actor_name ? (
                    <>
                      <span
                        className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[9px] font-semibold"
                        aria-hidden
                      >
                        {initialsOf(item.actor_name)}
                      </span>
                      {item.actor_name}
                      <span aria-hidden>·</span>
                    </>
                  ) : null}
                  <time dateTime={item.occurred_at} title={formatDateTime(item.occurred_at, timezone)}>
                    {formatRelative(item.occurred_at)}
                  </time>
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      {!exhausted ? (
        <Button variant="outline" size="sm" onClick={loadMore} loading={loadingMore}>
          Load earlier activity
        </Button>
      ) : null}
    </div>
  );
}
