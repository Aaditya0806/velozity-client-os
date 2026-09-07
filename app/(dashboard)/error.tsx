'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/empty-state';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    // The message is already on the server logs; this records that the user saw it.
    console.error('Page error', error);
  }, [error]);

  return (
    <ErrorState
      title="This page could not be loaded"
      description="Something went wrong while preparing this view. Trying again often resolves it."
      requestId={error.digest}
      action={<Button onClick={reset}>Try again</Button>}
    />
  );
}
