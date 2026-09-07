'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Menu, X, LogOut, Building2, ChevronDown } from 'lucide-react';
import { portalNavigation, isPortalActive } from '@/lib/config/portal-navigation';
import type { PortalCapabilities } from '@/lib/auth/portal';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/util/cn';

/**
 * The client's shell.
 *
 * Deliberately unlike the internal application: a light, narrow, calm surface
 * with five destinations at most. A client should never have to work out which
 * parts of a busy tool are meant for them — the answer here is all of it.
 */
export function PortalShell({
  companyName,
  companies,
  userName,
  capabilities,
  children,
}: {
  companyName: string;
  companies: Array<{ id: string; name: string }>;
  userName: string;
  capabilities: PortalCapabilities;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const items = portalNavigation(capabilities);

  const chooseCompany = (id: string) => {
    document.cookie = `velozity_portal_company=${id}; path=/; max-age=31536000; samesite=lax`;
    // A full reload, because the active company changes what every server
    // component on the page is allowed to read.
    window.location.href = '/portal';
  };

  return (
    <div className="min-h-dvh bg-[var(--vz-canvas)]">
      <header className="sticky top-0 z-40 border-b bg-card/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 lg:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? <X className="h-4 w-4" aria-hidden /> : <Menu className="h-4 w-4" aria-hidden />}
            <span className="sr-only">Toggle navigation</span>
          </Button>

          <Link href="/portal" className="flex shrink-0 items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-500 text-sm font-bold text-white">
              V
            </span>
            <span className="hidden text-[15px] font-semibold tracking-tight sm:inline">
              Client portal
            </span>
          </Link>

          <nav className="ml-4 hidden items-center gap-1 md:flex">
            {items.map((item) => {
              const active = isPortalActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'rounded-lg px-3 py-2 text-sm transition-colors',
                    active
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {companies.length > 1 ? (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setSwitcherOpen((v) => !v)}
                  className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
                  aria-expanded={switcherOpen}
                >
                  <Building2 className="h-3.5 w-3.5 opacity-60" aria-hidden />
                  <span className="max-w-[10rem] truncate">{companyName}</span>
                  <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
                </button>
                {switcherOpen ? (
                  <div className="absolute right-0 z-50 mt-1 w-56 overflow-hidden rounded-xl border bg-card shadow-lg">
                    {companies.map((company) => (
                      <button
                        key={company.id}
                        type="button"
                        onClick={() => chooseCompany(company.id)}
                        className="block w-full truncate px-3 py-2 text-left text-sm hover:bg-accent"
                      >
                        {company.name}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <span className="hidden max-w-[12rem] truncate text-xs text-muted-foreground sm:inline">
                {companyName}
              </span>
            )}

            <span className="hidden h-6 w-px bg-border sm:block" />
            <span className="hidden text-xs font-medium sm:inline">{userName}</span>

            <Button
              variant="ghost"
              size="icon-sm"
              title="Sign out"
              onClick={async () => {
                // The endpoint answers with JSON rather than a redirect, so the
                // navigation happens here; a plain form post would land the
                // client on a page of JSON.
                await fetch('/api/v1/auth/sign-out', { method: 'POST' });
                router.push('/sign-in');
                router.refresh();
              }}
            >
              <LogOut className="h-4 w-4" aria-hidden />
              <span className="sr-only">Sign out</span>
            </Button>
          </div>
        </div>

        {open ? (
          <nav className="border-t px-4 py-2 md:hidden">
            {items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="block rounded-lg px-3 py-2.5 text-sm hover:bg-accent"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        ) : null}
      </header>

      <main id="main-content" className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
        {children}
      </main>

      <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-muted-foreground lg:px-6">
        Questions about anything here? Reply to your usual contact — this portal
        shows the same records your delivery team works from.
      </footer>
    </div>
  );
}
