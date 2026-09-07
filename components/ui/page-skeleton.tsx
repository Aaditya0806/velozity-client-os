import { Skeleton, SkeletonTable, SkeletonCards } from './skeleton';

/**
 * The placeholder a route shows while its data loads.
 *
 * Next swaps to this the instant a link is clicked, so navigation feels
 * immediate even when the server is a few hundred milliseconds away. Without a
 * loading state the browser sits on the previous page for the whole round trip,
 * which reads as the click not having registered.
 *
 * The shape mirrors the real page so the layout does not jump when data lands.
 */
export function PageSkeleton({
  variant = 'table',
  columns = 6,
  hasAction = false,
}: {
  variant?: 'table' | 'cards' | 'board' | 'detail';
  columns?: number;
  hasAction?: boolean;
}) {
  return (
    <div className="space-y-6" role="status" aria-label="Loading">
      <span className="sr-only">Loading</span>

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>
        {hasAction ? <Skeleton className="h-9 w-32 rounded-xl" /> : null}
      </div>

      {variant === 'cards' ? (
        <SkeletonCards count={6} />
      ) : variant === 'board' ? (
        <div className="flex gap-4 overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="w-72 shrink-0 space-y-2 rounded-2xl border p-2">
              <Skeleton className="mb-3 h-5 w-32" />
              {Array.from({ length: 2 }).map((_, j) => (
                <Skeleton key={j} className="h-28 rounded-xl" />
              ))}
            </div>
          ))}
        </div>
      ) : variant === 'detail' ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-56 rounded-2xl" />
          </div>
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      ) : (
        <>
          <Skeleton className="h-9 w-64 rounded-xl" />
          <div className="rounded-2xl border">
            <SkeletonTable columns={columns} />
          </div>
        </>
      )}
    </div>
  );
}
