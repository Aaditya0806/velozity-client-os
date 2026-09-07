'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { visibleNavigation, isActive } from '@/lib/config/navigation';
import { cn } from '@/lib/util/cn';
import { Button } from '@/components/ui/button';

/**
 * The navigation rail.
 *
 * Collapses to a 68px icon rail, and the choice is remembered in a cookie so it
 * survives a reload — a preference that resets on every visit is not a
 * preference.
 *
 * The detail worth noticing is the active item: it takes the canvas colour and
 * loses its right radius, so the selected row appears to merge into the content
 * panel beside it rather than floating on the navy. It is what makes the rail
 * read as part of the page instead of a menu bolted to its edge.
 */
export function Sidebar({
  permissions,
  orgName,
  collapsed,
  onCollapsedChange,
  mobileOpen,
  onMobileClose,
}: {
  permissions: string[];
  orgName: string;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const pathname = usePathname();
  const sections = visibleNavigation(permissions);

  const toggle = () => {
    const next = !collapsed;
    onCollapsedChange(next);
    // A year, because this is a workspace preference rather than session state.
    document.cookie = `velozity_nav=${next ? 'mini' : 'full'}; path=/; max-age=31536000; samesite=lax`;
  };

  return (
    <>
      {mobileOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] lg:hidden"
          onClick={onMobileClose}
          aria-hidden
        />
      ) : null}

      <aside
        data-collapsed={collapsed}
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex shrink-0 flex-col bg-[var(--vz-sidebar)]',
          'transition-[width,transform] duration-300 ease-out lg:static lg:translate-x-0',
          collapsed ? 'lg:w-[68px]' : 'lg:w-64',
          'w-64',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Main navigation"
      >
        {/* --------------------------------------------------------- brand */}
        <div
          className={cn(
            'flex h-16 shrink-0 items-center gap-2.5',
            collapsed ? 'lg:justify-center lg:px-3' : '',
            'px-5',
          )}
        >
          <Link
            href="/dashboard"
            onClick={onMobileClose}
            className="flex min-w-0 items-center gap-2.5 outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-0"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand-500 text-sm font-bold text-white shadow-[0_4px_14px_-4px_hsl(var(--brand-500))]">
              V
            </span>
            {!collapsed ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[15px] font-semibold tracking-tight text-white">
                  Velozity
                </span>
                <span className="mt-0.5 rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-slate-300">
                  OS
                </span>
              </span>
            ) : null}
          </Link>

          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto text-slate-400 hover:bg-white/10 hover:text-white lg:hidden"
            onClick={onMobileClose}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close navigation</span>
          </Button>
        </div>

        {/* ----------------------------------------------------------- nav */}
        <div className="relative min-h-0 flex-1">
          <nav
            className={cn(
              'vz-no-scrollbar h-full overflow-y-auto overflow-x-hidden pb-6',
              collapsed ? 'lg:px-2' : '',
              'px-3',
            )}
          >
            {sections.map((section, index) => (
              <div key={section.label ?? index} className={cn('last:mb-0', collapsed ? 'lg:mb-2' : '', 'mb-5')}>
                {section.label ? (
                  collapsed ? (
                    <div className="mx-auto my-2 hidden h-px w-5 bg-white/[0.08] lg:block" aria-hidden />
                  ) : (
                    <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                      {section.label}
                    </p>
                  )
                ) : null}

                <div className={cn(collapsed ? 'lg:space-y-0.5' : '', 'space-y-1')}>
                  {section.items.map((item) => {
                    const active = isActive(pathname, item);

                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={onMobileClose}
                        aria-current={active ? 'page' : undefined}
                        title={collapsed ? item.label : undefined}
                        className={cn(
                          'group relative flex items-center rounded-2xl text-sm outline-none transition-colors',
                          'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400',
                          collapsed
                            ? 'lg:mx-auto lg:h-10 lg:w-10 lg:justify-center lg:gap-0 lg:px-0'
                            : '',
                          'h-11 gap-3 px-3',
                          // The active row bleeds into the content panel.
                          !collapsed && active && '-mr-3 rounded-r-none pr-6',
                          active
                            ? 'bg-[var(--vz-canvas)] font-semibold text-slate-900 dark:text-white'
                            : 'text-slate-400 hover:bg-white/[0.07] hover:text-white',
                        )}
                      >
                        <item.icon
                          className={cn(
                            'h-[18px] w-[18px] shrink-0 transition-colors',
                            active
                              ? 'text-brand-600 dark:text-brand-400'
                              : 'text-slate-400 group-hover:text-white',
                          )}
                          strokeWidth={1.75}
                          aria-hidden
                        />
                        <span className={cn('truncate', collapsed ? 'lg:hidden' : '')}>
                          {item.label}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          {/* The only hint that the list runs on. There is no visible bar. */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[var(--vz-sidebar)] to-transparent"
            aria-hidden
          />
        </div>

        {/* ---------------------------------------------------------- foot */}
        <div
          className={cn(
            'flex shrink-0 items-center gap-2 border-t border-white/[0.06] py-3',
            collapsed ? 'lg:justify-center lg:px-2' : '',
            'px-4',
          )}
        >
          {!collapsed ? (
            <p className="min-w-0 flex-1 truncate text-xs text-slate-500" title={orgName}>
              {orgName}
            </p>
          ) : null}

          <button
            type="button"
            onClick={toggle}
            title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 outline-none transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:ring-2 focus-visible:ring-brand-400 lg:flex"
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" aria-hidden />
            ) : (
              <PanelLeftClose className="h-4 w-4" aria-hidden />
            )}
            <span className="sr-only">
              {collapsed ? 'Expand navigation' : 'Collapse navigation'}
            </span>
          </button>
        </div>
      </aside>
    </>
  );
}
