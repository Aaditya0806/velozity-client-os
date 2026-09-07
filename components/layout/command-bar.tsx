'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import {
  Building2, GitBranch, FolderKanban, CheckSquare, Scale, Users, Search,
  Loader2, CornerDownLeft, ArrowUp, ArrowDown,
} from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { visibleNavigation } from '@/lib/config/navigation';

interface SearchResults {
  companies: Array<{ id: string; title: string; subtitle: string }>;
  contacts: Array<{ id: string; title: string; subtitle: string }>;
  opportunities: Array<{ id: string; title: string; subtitle: string }>;
  projects: Array<{ id: string; title: string; subtitle: string }>;
  tasks: Array<{ id: string; title: string; subtitle: string }>;
  contracts: Array<{ id: string; title: string; subtitle: string }>;
}

const GROUPS = [
  { key: 'companies', label: 'Clients', icon: Building2, href: (id: string) => `/clients/${id}` },
  { key: 'contacts', label: 'Contacts', icon: Users, href: (id: string) => `/clients?contact=${id}` },
  { key: 'opportunities', label: 'Opportunities', icon: GitBranch, href: (id: string) => `/pipeline/${id}` },
  { key: 'projects', label: 'Projects', icon: FolderKanban, href: (id: string) => `/projects/${id}` },
  { key: 'tasks', label: 'Tasks', icon: CheckSquare, href: (id: string) => `/tasks/${id}` },
  { key: 'contracts', label: 'Contracts', icon: Scale, href: (id: string) => `/legal/contracts/${id}` },
] as const;

/**
 * Global search and navigation.
 *
 * Two things at once, because they are the same act from the user's side:
 * jumping to a page and jumping to a record. Pages match instantly from the
 * navigation list already in memory; records come from the server, where RLS
 * has already decided what exists — so nothing can be found here that could not
 * be opened.
 */
export function CommandBar({ permissions }: { permissions: string[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<SearchResults | null>(null);
  const [loading, setLoading] = React.useState(false);

  const pages = React.useMemo(
    () => visibleNavigation(permissions).flatMap((section) => section.items),
    [permissions],
  );

  const matchingPages = React.useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return pages.slice(0, 6);
    return pages
      .filter(
        (item) =>
          item.label.toLowerCase().includes(term) ||
          (item.keywords ?? '').toLowerCase().includes(term),
      )
      .slice(0, 6);
  }, [pages, query]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
      // `/` is the other muscle memory for search, but not while the user is
      // already typing into something.
      if (
        event.key === '/' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !(event.target as HTMLElement | null)?.isContentEditable
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  React.useEffect(() => {
    if (query.trim().length < 2) {
      setResults(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/v1/search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (response.ok) {
          const body = (await response.json()) as { data: SearchResults };
          setResults(body.data);
        }
      } catch {
        // An aborted request is the normal case while typing.
      } finally {
        setLoading(false);
      }
    }, 220);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const go = (href: string) => {
    setOpen(false);
    setQuery('');
    router.push(href);
  };

  const hasRecords =
    results && GROUPS.some((g) => (results[g.key as keyof SearchResults] ?? []).length > 0);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group flex h-9 w-full max-w-md items-center gap-2 rounded-xl border bg-background px-3 text-sm text-muted-foreground transition-colors hover:border-brand-300 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search className="h-4 w-4 shrink-0 transition-colors group-hover:text-brand-500" aria-hidden />
        <span className="flex-1 truncate text-left">Search or jump to…</span>
        <kbd className="hidden shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-2xs sm:inline">
          ⌘K
        </kbd>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
          <DialogTitle className="sr-only">Search and navigate</DialogTitle>

          <Command shouldFilter={false} loop className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5">
            <div className="flex items-center border-b px-3">
              <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Search clients, deals, contracts — or jump to a page…"
                className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              {loading ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
              ) : null}
            </div>

            <Command.List className="vz-quiet-scroll max-h-[22rem] overflow-y-auto p-2">
              {matchingPages.length > 0 ? (
                <Command.Group
                  heading={
                    <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {query.trim() ? 'Pages' : 'Jump to'}
                    </span>
                  }
                >
                  {matchingPages.map((item) => (
                    <Command.Item
                      key={item.href}
                      value={`page-${item.href}`}
                      onSelect={() => go(item.href)}
                      className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none aria-selected:bg-accent"
                    >
                      <item.icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="flex-1 truncate">{item.label}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}

              {query.trim().length >= 2 && !loading && !hasRecords ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No records matched “{query}”.
                </p>
              ) : null}

              {GROUPS.map((group) => {
                const items = results?.[group.key as keyof SearchResults] ?? [];
                if (items.length === 0) return null;
                return (
                  <Command.Group
                    key={group.key}
                    heading={
                      <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {group.label}
                      </span>
                    }
                  >
                    {items.map((item) => (
                      <Command.Item
                        key={item.id}
                        value={`${group.key}-${item.id}`}
                        onSelect={() => go(group.href(item.id))}
                        className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none aria-selected:bg-accent"
                      >
                        <group.icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="flex-1 truncate">{item.title}</span>
                        <span className="shrink-0 truncate text-xs text-muted-foreground">
                          {item.subtitle}
                        </span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                );
              })}
            </Command.List>

            <div className="flex items-center gap-4 border-t px-3 py-2 text-2xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <ArrowUp className="h-3 w-3" aria-hidden />
                <ArrowDown className="h-3 w-3" aria-hidden />
                navigate
              </span>
              <span className="flex items-center gap-1">
                <CornerDownLeft className="h-3 w-3" aria-hidden />
                open
              </span>
              <span className="ml-auto">esc to close</span>
            </div>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
