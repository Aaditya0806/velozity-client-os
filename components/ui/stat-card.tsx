import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/util/cn';
import { CountUp } from './count-up';

/**
 * A single headline figure.
 *
 * The value uses tabular figures so a row of these lines up, and any change is
 * described in words as well as by colour and an arrow — a red down-arrow means
 * nothing to a screen reader, and not much to anyone who cannot distinguish it
 * from the green one.
 *
 * Passing `href` makes the whole tile a link, which is when the hover lift is
 * justified.
 */
export function StatCard({
  label,
  value,
  hint,
  delta,
  icon: Icon,
  tone = 'default',
  href,
  animate = true,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: { value: string; direction: 'up' | 'down' | 'flat'; good?: boolean };
  icon?: LucideIcon;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  href?: string;
  animate?: boolean;
  className?: string;
}) {
  const toneClass = {
    default: '',
    success: 'text-[hsl(var(--success))]',
    warning: 'text-[hsl(var(--warning))]',
    danger: 'text-destructive',
  }[tone];

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {Icon ? (
          <span
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors',
              tone === 'success'
                ? 'bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]'
                : tone === 'warning'
                  ? 'bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]'
                  : tone === 'danger'
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-brand-500/10 text-brand-600 dark:text-brand-400',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        ) : null}
      </div>

      <p className={cn('tabular mt-3 text-2xl font-semibold tracking-tight', toneClass)}>
        {animate ? <CountUp value={value} /> : value}
      </p>

      {delta ? (
        <p
          className={cn(
            'mt-1 text-xs',
            delta.direction === 'flat'
              ? 'text-muted-foreground'
              : delta.good === false
                ? 'text-destructive'
                : 'text-[hsl(var(--success))]',
          )}
        >
          <span aria-hidden>
            {delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : '→'}
          </span>{' '}
          {delta.value}
          <span className="sr-only">
            {delta.direction === 'up'
              ? ' increase'
              : delta.direction === 'down'
                ? ' decrease'
                : ' unchanged'}
          </span>
        </p>
      ) : null}

      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className={cn(
          'vz-card group relative block rounded-2xl border bg-card p-5 outline-none',
          'transition-[transform,box-shadow] duration-200',
          'hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgba(15,23,42,.05),0_16px_36px_-20px_rgba(15,23,42,.24)]',
          'focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
      >
        {body}
        <ArrowRight
          className="absolute bottom-5 right-5 h-4 w-4 translate-x-1 text-muted-foreground opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100"
          aria-hidden
        />
      </Link>
    );
  }

  return (
    <div className={cn('vz-card rounded-2xl border bg-card p-5', className)}>{body}</div>
  );
}
