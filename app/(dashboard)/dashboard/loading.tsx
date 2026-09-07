import { SkeletonCards } from '@/components/ui/skeleton';
import { Skeleton } from '@/components/ui/skeleton';

export default function DashboardLoading() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-7 w-40" />
        <Skeleton className="mt-2 h-4 w-64" />
      </div>
      <SkeletonCards count={4} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border p-5 lg:col-span-2">
          <Skeleton className="h-4 w-32" />
          <div className="mt-6 space-y-3">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-5" />
            ))}
          </div>
        </div>
        <div className="rounded-lg border p-5">
          <Skeleton className="h-4 w-28" />
          <div className="mt-6 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-4" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
