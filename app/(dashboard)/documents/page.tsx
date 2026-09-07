import type { Metadata } from 'next';
import { FileText, Lock, ShieldAlert } from 'lucide-react';
import { requireContext, query } from '@/lib/auth/session';
import { listDocuments, documentListSchema } from '@/lib/documents';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/lib/util/format';

export const metadata: Metadata = { title: 'Documents' };
export const dynamic = 'force-dynamic';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireContext();
  const params = await searchParams;

  const parsed = documentListSchema.safeParse(params);
  const listQuery = parsed.success ? parsed.data : documentListSchema.parse({});

  const result = await query(ctx, (tx) => listDocuments(tx, ctx, listQuery), { readOnly: true });
  const documents = result.rows as Array<Record<string, unknown>>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documents"
        description="Every file is versioned, hashed and served through a short-lived signed link."
      />

      {documents.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No documents"
          description="Uploaded files and generated contracts appear here."
        />
      ) : (
        <div className="rounded-lg border divide-y">
          {documents.map((document) => (
            <div
              key={String(document.id)}
              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{String(document.name)}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {String(document.category).replace(/_/g, ' ')}
                  {document.company_name ? ` · ${String(document.company_name)}` : ''}
                  {' · '}
                  {formatDate(document.created_at as string)}
                  {document.size_bytes ? ` · ${formatBytes(Number(document.size_bytes))}` : ''}
                  {document.version_no ? ` · v${String(document.version_no)}` : ''}
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {document.status === 'quarantined' ? (
                  <Badge variant="danger" className="gap-1">
                    <ShieldAlert className="h-3 w-3" aria-hidden />
                    Quarantined
                  </Badge>
                ) : null}
                {document.is_immutable ? (
                  <Badge variant="success" className="gap-1">
                    <Lock className="h-3 w-3" aria-hidden />
                    Sealed
                  </Badge>
                ) : null}
                {document.is_confidential ? <Badge variant="warning">Confidential</Badge> : null}
                {document.status === 'quarantined' ? (
                  <span className="text-sm text-muted-foreground">Download blocked</span>
                ) : (
                  <a
                    href={`/api/v1/documents/${String(document.id)}/download`}
                    className="text-sm text-primary hover:underline"
                  >
                    Download
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Download links expire after 15 minutes. Every link issued is recorded against the
        document, and a file whose stored bytes no longer match its recorded hash is
        quarantined rather than served.
      </p>
    </div>
  );
}
