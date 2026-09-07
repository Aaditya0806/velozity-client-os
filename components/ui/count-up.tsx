'use client';

import * as React from 'react';

/**
 * Counts a number up on first paint.
 *
 * A client island on purpose: it is the only part of a stat tile that needs
 * JavaScript, so keeping it separate lets StatCard stay a Server Component and
 * accept an icon component as a prop — functions cannot cross the server/client
 * boundary.
 *
 * Only genuine numbers animate. Anything with letters in it, or an em dash for
 * "no data", is rendered straight through, because animating "—" toward "—" is
 * nonsense. Honours prefers-reduced-motion.
 */
export function CountUp({ value, durationMs = 550 }: { value: string; durationMs?: number }) {
  const [display, setDisplay] = React.useState(value);
  const frame = React.useRef<number | undefined>(undefined);

  React.useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // Split into a numeric core and whatever surrounds it, so "£32.4k" animates
    // the 32.4 and keeps the currency symbol and the suffix intact.
    const match = value.match(/^(\D*?)([\d,]+(?:\.\d+)?)(.*)$/);
    if (reduced || !match) {
      setDisplay(value);
      return;
    }

    const [, prefix = '', numeric = '0', suffix = ''] = match;
    const target = Number.parseFloat(numeric.replace(/,/g, ''));
    if (Number.isNaN(target)) {
      setDisplay(value);
      return;
    }

    const decimals = numeric.includes('.') ? (numeric.split('.')[1]?.length ?? 0) : 0;
    const grouped = numeric.includes(',');
    const started = performance.now();

    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / durationMs);
      // Ease-out cubic: quick at first, settling gently on the final figure.
      const eased = 1 - (1 - progress) ** 3;
      const current = target * eased;

      const rendered = grouped
        ? current.toLocaleString(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          })
        : current.toFixed(decimals);

      setDisplay(`${prefix}${rendered}${suffix}`);
      if (progress < 1) frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [value, durationMs]);

  // The final value is always in the DOM for assistive tech, whatever the
  // animation happens to be showing.
  return (
    <>
      <span aria-hidden>{display}</span>
      <span className="sr-only">{value}</span>
    </>
  );
}
