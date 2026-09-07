'use client';

import * as React from 'react';

/**
 * The current time in the organisation's timezone.
 *
 * Rendered as an empty placeholder until the first client tick, because the
 * server and the browser will disagree about "now" and React would report the
 * mismatch as a hydration error. The width is reserved so the header does not
 * shift when the time arrives.
 */
export function LiveClock({
  timezone,
  showSeconds = false,
}: {
  timezone: string;
  showSeconds?: boolean;
}) {
  const [now, setNow] = React.useState<string | null>(null);

  React.useEffect(() => {
    const format = () =>
      new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        ...(showSeconds ? { second: '2-digit' } : {}),
        hour12: false,
        timeZone: timezone || 'UTC',
      }).format(new Date());

    setNow(format());
    // Ticking every second even when only minutes are shown keeps the change
    // punctual; a 60s interval drifts and can land 59 seconds late.
    const timer = setInterval(() => setNow(format()), 1000);
    return () => clearInterval(timer);
  }, [timezone, showSeconds]);

  return (
    <span
      className="inline-block min-w-[3.25rem] text-right"
      suppressHydrationWarning
      title={timezone}
    >
      {now ?? ''}
    </span>
  );
}
