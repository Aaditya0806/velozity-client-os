import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

/**
 * The dashboard hero.
 *
 * A dark gradient band that carries the shell's navy up into the page, so the
 * canvas does not begin with an abrupt grey. It greets by name and states the
 * one thing most worth acting on, rather than being decoration.
 */
export function DashboardHero({
  name,
  orgName,
  headline,
  action,
}: {
  name: string;
  orgName: string;
  headline: string;
  action?: { label: string; href: string };
}) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = name.split(/\s+/)[0] ?? name;

  return (
    <section
      className="relative overflow-hidden rounded-2xl px-6 py-7 text-white sm:px-8"
      style={{
        background:
          'linear-gradient(135deg, var(--vz-hero-a) 0%, var(--vz-hero-b) 55%, var(--vz-hero-c) 100%)',
      }}
    >
      {/* A soft brand bloom, so the band is not a flat rectangle. */}
      <div
        className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-brand-500/20 blur-3xl"
        aria-hidden
      />

      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-400">
            {orgName}
          </p>
          <h1 className="mt-1.5 text-xl font-semibold tracking-tight sm:text-2xl">
            {greeting}, {firstName}
          </h1>
          <p className="mt-1.5 max-w-xl text-sm text-slate-300">{headline}</p>
        </div>

        {action ? (
          <Link
            href={action.href}
            className="group inline-flex shrink-0 items-center gap-2 rounded-xl bg-white/10 px-4 py-2 text-sm font-medium text-white outline-none ring-1 ring-inset ring-white/15 backdrop-blur transition-colors hover:bg-white/[0.18] focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            {action.label}
            <ArrowRight
              className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
              aria-hidden
            />
          </Link>
        ) : null}
      </div>
    </section>
  );
}
