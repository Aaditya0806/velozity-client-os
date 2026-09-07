'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, LogOut, Settings, Building2, Check, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/util/cn';

interface Membership {
  id: string;
  name: string;
  slug: string;
}

export function UserMenu({
  fullName,
  email,
  roleLabel,
  orgSlug,
  memberships,
}: {
  fullName: string;
  email: string;
  roleLabel: string;
  orgSlug: string;
  memberships: Membership[];
}) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [switching, setSwitching] = React.useState(false);

  const initials = fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || email[0]?.toUpperCase() || '?';

  const switchOrg = async (slug: string) => {
    if (slug === orgSlug) return;
    setSwitching(true);
    await fetch('/api/v1/me/organization', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
    // A full reload, not a soft refresh: the tenant context sits underneath
    // every cached server component on the page.
    window.location.href = '/dashboard';
  };

  const signOut = async () => {
    await fetch('/api/v1/auth/sign-out', { method: 'POST' });
    router.push('/sign-in');
    router.refresh();
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" className="h-9 gap-2 px-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-2xs font-semibold text-primary-foreground">
            {initials}
          </span>
          <span className="hidden max-w-32 truncate text-sm sm:inline">{fullName}</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="z-50 w-64 rounded-lg border bg-popover p-1 shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          <div className="px-3 py-2.5">
            <p className="truncate text-sm font-medium">{fullName}</p>
            <p className="truncate text-xs text-muted-foreground">{email}</p>
            <p className="mt-1 text-2xs uppercase tracking-wide text-muted-foreground">
              {roleLabel}
            </p>
          </div>

          <DropdownMenu.Separator className="my-1 h-px bg-border" />

          {memberships.length > 1 ? (
            <>
              <DropdownMenu.Label className="px-3 py-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Organisation
              </DropdownMenu.Label>
              {memberships.map((membership) => (
                <DropdownMenu.Item
                  key={membership.id}
                  disabled={switching}
                  onSelect={() => void switchOrg(membership.slug)}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm outline-none',
                    'data-[highlighted]:bg-accent data-[disabled]:opacity-50',
                  )}
                >
                  <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden />
                  <span className="flex-1 truncate">{membership.name}</span>
                  {membership.slug === orgSlug ? <Check className="h-4 w-4" aria-hidden /> : null}
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
            </>
          ) : null}

          <DropdownMenu.Item asChild>
            <Link
              href="/settings"
              className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm outline-none data-[highlighted]:bg-accent"
            >
              <Settings className="h-4 w-4 text-muted-foreground" aria-hidden />
              Settings
            </Link>
          </DropdownMenu.Item>

          <DropdownMenu.Item
            onSelect={(e) => {
              e.preventDefault();
              setTheme(theme === 'dark' ? 'light' : 'dark');
            }}
            className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm outline-none data-[highlighted]:bg-accent"
          >
            {theme === 'dark' ? (
              <Sun className="h-4 w-4 text-muted-foreground" aria-hidden />
            ) : (
              <Moon className="h-4 w-4 text-muted-foreground" aria-hidden />
            )}
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="my-1 h-px bg-border" />

          <DropdownMenu.Item
            onSelect={() => void signOut()}
            className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm text-destructive outline-none data-[highlighted]:bg-destructive/10"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
