import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FileQuestion } from 'lucide-react';

export default function NotFound() {
  return (
    <EmptyState
      icon={FileQuestion}
      title="Not found"
      description="This record does not exist, or you do not have access to it."
      action={
        <Button asChild variant="outline">
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
      }
    />
  );
}
