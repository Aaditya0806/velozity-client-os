'use client';

import * as React from 'react';
import Link from 'next/link';
import { Bell, Check } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/util/cn';

interface Notification {
  id: string;
  category: string;
  title: string;
  body: string | null;
  link_url: string | null;
  priority: string;
  read_at: string | null;
  created_at: string;
}

export function NotificationBell() {
  const [items, setItems] = React.useState<Notification[]>([]);
  const [unread, setUnread] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    try {
      const response = await fetch('/api/v1/notifications?page_size=15');
      if (!response.ok) return;
      const body = (await response.json()) as {
        data: Notification[];
        meta: { unread_count: number };
      };
      setItems(body.data);
      setUnread(body.meta.unread_count);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    // Polling rather than a socket: this is a low-frequency signal and a
    // websocket per user would be a lot of machinery for a badge count.
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const markAllRead = async () => {
    setItems((current) => current.map((n) => ({ ...n, read_at: new Date().toISOString() })));
    setUnread(0);
    await fetch('/api/v1/notifications', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'read', all: true }),
    });
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-4 w-4" aria-hidden />
          {unread > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-2xs font-semibold text-destructive-foreground">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
          <span className="sr-only">
            {unread > 0 ? `${unread} unread notifications` : 'Notifications'}
          </span>
        </Button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-[22rem] rounded-lg border bg-popover shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <p className="text-sm font-semibold">Notifications</p>
            {unread > 0 ? (
              <Button variant="ghost" size="sm" onClick={markAllRead} className="h-7 text-xs">
                <Check className="h-3.5 w-3.5" />
                Mark all read
              </Button>
            ) : null}
          </div>

          <div className="scrollbar-thin max-h-96 overflow-y-auto">
            {loading ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
            ) : items.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                You are all caught up.
              </p>
            ) : (
              <ul className="divide-y">
                {items.map((item) => {
                  const content = (
                    <div
                      className={cn(
                        'px-4 py-3 transition-colors hover:bg-accent',
                        !item.read_at && 'bg-primary/[0.04]',
                      )}
                    >
                      <div className="flex items-start gap-2">
                        {!item.read_at ? (
                          <span
                            className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                            aria-label="Unread"
                          />
                        ) : (
                          <span className="mt-1.5 h-1.5 w-1.5 shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium leading-snug">{item.title}</p>
                          {item.body ? (
                            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                              {item.body}
                            </p>
                          ) : null}
                          <p className="mt-1 text-2xs text-muted-foreground">
                            {new Date(item.created_at).toLocaleString()}
                          </p>
                        </div>
                      </div>
                    </div>
                  );

                  return (
                    <li key={item.id}>
                      {item.link_url ? (
                        <Link href={item.link_url} onClick={() => setOpen(false)}>
                          {content}
                        </Link>
                      ) : (
                        content
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
