'use client';

import * as React from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

/**
 * Fetches a short-lived signed URL, then opens it.
 *
 * The link is issued per click rather than rendered into the page: a signed URL
 * sitting in server-rendered HTML outlives the page it was meant for, and gets
 * shared, cached and indexed along with it.
 */
export function DocumentDownload({ documentId, name }: { documentId: string; name: string }) {
  const [busy, setBusy] = React.useState(false);

  const download = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/portal/documents/${documentId}/download`);
      const body = (await response.json()) as {
        data?: { url: string };
        error?: { message: string };
      };

      if (!response.ok || !body.data?.url) {
        toast.error(body.error?.message ?? 'That file could not be retrieved.');
        return;
      }

      window.location.href = body.data.url;
    } catch {
      toast.error('Could not reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={() => void download()} disabled={busy}>
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <Download className="h-3.5 w-3.5" aria-hidden />
      )}
      <span className="sr-only">Download {name}</span>
      <span aria-hidden>Download</span>
    </Button>
  );
}
