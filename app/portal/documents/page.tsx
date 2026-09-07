import type { Metadata } from 'next';
import { FileText } from 'lucide-react';
import { redirect } from 'next/navigation';
import { requirePortalContext, portalQuery } from '@/lib/auth/portal';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { DocumentDownload } from '@/components/portal/document-download';
import { formatDate } from '@/lib/util/format';

export const metadata: Metadata = { title: 'Documents' };
export const dynamic = 'force-dynamic';

interface DocumentRow {
  id: string;
  name: string;
  description: string | null;
  category: string;
  created_at: string;
}

export default async function PortalDocumentsPage() {
  const ctx = await requirePortalContext();

  // The capability is checked here, in the view, and again in
  // app.portal_document_for_download. This one only decides what to render.
  if (!ctx.company.capabilities.viewDocuments) redirect('/portal');

  const documents = await portalQuery(ctx, (tx) =>
    tx.many<DocumentRow>(
      `select id, name, description, category, created_at
         from portal.documents
        order by created_at desc`,
    ),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Files shared with {ctx.company.name}. Links expire fifteen minutes after you request one.
        </p>
      </div>

      {documents.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No documents yet"
          description="Anything your team shares with you will be listed here."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y">
              {documents.map((doc) => (
                <li key={doc.id} className="flex items-center gap-3 px-5 py-4">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{doc.name}</p>
                    {doc.description ? (
                      <p className="truncate text-sm text-muted-foreground">{doc.description}</p>
                    ) : null}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Added {formatDate(doc.created_at)}
                    </p>
                  </div>
                  <Badge variant="neutral">{doc.category.replace(/_/g, ' ')}</Badge>
                  <DocumentDownload documentId={doc.id} name={doc.name} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
