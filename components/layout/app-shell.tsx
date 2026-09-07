'use client';

import * as React from 'react';
import { Menu, Clock } from 'lucide-react';
import { Sidebar } from './sidebar';
import { CommandBar } from './command-bar';
import { NotificationBell } from './notification-bell';
import { UserMenu } from './user-menu';
import { LiveClock } from './live-clock';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/util/cn';

export interface ShellUser {
  fullName: string;
  email: string;
  roleLabel: string;
}

/**
 * The application shell.
 *
 * A navy frame with the content floating inside it as a panel: rounded on the
 * side away from the rail, lifted with a wide soft shadow. Only the panel
 * scrolls, so the header and the navigation stay put while a long table moves
 * beneath them.
 */
export function AppShell({
  user,
  orgName,
  orgSlug,
  isDemo,
  permissions,
  memberships,
  initialCollapsed,
  timezone,
  children,
}: {
  user: ShellUser;
  orgName: string;
  orgSlug: string;
  isDemo: boolean;
  permissions: string[];
  memberships: Array<{ id: string; name: string; slug: string }>;
  initialCollapsed: boolean;
  timezone: string;
  children: React.ReactNode;
}) {
  const [navOpen, setNavOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(initialCollapsed);
  const scrollRef = React.useRef<HTMLElement>(null);

  // Shows the scrollbar thumb only while the panel is actually moving, then
  // fades it out again. See `.vz-quiet-scroll`.
  React.useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    let timer: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      node.classList.add('is-scrolling');
      clearTimeout(timer);
      timer = setTimeout(() => node.classList.remove('is-scrolling'), 700);
    };

    node.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      node.removeEventListener('scroll', onScroll);
      clearTimeout(timer);
    };
  }, []);

  return (
    <div className="flex h-dvh overflow-hidden bg-[var(--vz-shell)]">
      <Sidebar
        permissions={permissions}
        orgName={orgName}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        mobileOpen={navOpen}
        onMobileClose={() => setNavOpen(false)}
      />

      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col overflow-hidden bg-card',
          'lg:my-2 lg:mr-2 lg:rounded-2xl lg:shadow-[0_20px_60px_-30px_rgba(0,0,0,0.5)]',
        )}
      >
        <header className="z-30 flex h-16 shrink-0 items-center gap-3 border-b bg-card/80 px-4 backdrop-blur-xl lg:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setNavOpen(true)}
          >
            <Menu className="h-4 w-4" aria-hidden />
            <span className="sr-only">Open navigation</span>
          </Button>

          <div className="min-w-0 flex-1">
            <CommandBar permissions={permissions} />
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {isDemo ? (
              <span className="hidden rounded-md bg-[hsl(var(--warning))]/12 px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-[hsl(var(--warning))] md:inline">
                Demo data
              </span>
            ) : null}

            <span className="hidden items-center gap-1.5 text-xs font-medium tabular text-muted-foreground md:flex">
              <Clock className="h-3.5 w-3.5 opacity-60" aria-hidden />
              <LiveClock timezone={timezone} />
            </span>

            <span className="hidden h-6 w-px bg-border md:block" />

            <NotificationBell />

            <UserMenu
              fullName={user.fullName}
              email={user.email}
              roleLabel={user.roleLabel}
              orgSlug={orgSlug}
              memberships={memberships}
            />
          </div>
        </header>

        <main
          ref={scrollRef}
          id="main-content"
          className="vz-quiet-scroll flex-1 overflow-y-auto overscroll-contain bg-[var(--vz-canvas)] px-4 py-6 pb-16 lg:px-7"
        >
          <div className="animate-fade-up mx-auto max-w-[1600px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
