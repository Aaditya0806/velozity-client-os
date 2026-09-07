'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';

/**
 * Lead capture.
 *
 * Creates the company, the contact and the opportunity in a single request,
 * which the server performs in one transaction. An inbound enquiry never lands
 * as a company with no deal attached.
 */
export function NewOpportunityButton() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(event.currentTarget);
    const payload = {
      company: { name: String(form.get('company_name') ?? '').trim() },
      contact: {
        first_name: String(form.get('first_name') ?? '').trim(),
        last_name: String(form.get('last_name') ?? '').trim(),
        email: String(form.get('email') ?? '').trim() || null,
        contact_role: String(form.get('contact_role') ?? 'other'),
      },
      opportunity: {
        name: String(form.get('deal_name') ?? '').trim() || undefined,
        amount: String(form.get('amount') ?? '0') || '0',
        source: String(form.get('source') ?? '').trim() || null,
      },
    };

    try {
      const response = await fetch('/api/v1/opportunities/lead-capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const body = (await response.json()) as {
        data?: { opportunity: { id: string; reference: string } };
        error?: { message: string };
        request_id: string;
      };

      if (!response.ok) {
        setError(`${body.error?.message ?? 'Could not create this deal.'} (${body.request_id})`);
        setLoading(false);
        return;
      }

      toast.success(`${body.data?.opportunity.reference} created`);
      setOpen(false);
      setLoading(false);
      router.push(`/pipeline/${body.data?.opportunity.id}`);
      router.refresh();
    } catch {
      setError('Could not reach the server. Please try again.');
      setLoading(false);
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        New deal
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New deal</DialogTitle>
            <DialogDescription>
              Creates the client, the contact and the opportunity together.
              An existing client with the same name is reused.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={submit} className="space-y-4" noValidate>
            {error ? (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="company_name" required>
                Company
              </Label>
              <Input id="company_name" name="company_name" required autoFocus />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="first_name" required>
                  Contact first name
                </Label>
                <Input id="first_name" name="first_name" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="last_name">Last name</Label>
                <Input id="last_name" name="last_name" />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="email">Contact email</Label>
                <Input id="email" name="email" type="email" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contact_role">Their role</Label>
                <select
                  id="contact_role"
                  name="contact_role"
                  defaultValue="other"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="decision_maker">Decision maker</option>
                  <option value="economic_buyer">Economic buyer</option>
                  <option value="champion">Champion</option>
                  <option value="influencer">Influencer</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="deal_name">Deal name</Label>
              <Input id="deal_name" name="deal_name" placeholder="Defaults to the company name" />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="amount">Estimated value</Label>
                <Input id="amount" name="amount" inputMode="decimal" defaultValue="0" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="source">Source</Label>
                <Input id="source" name="source" placeholder="Referral, website…" />
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={loading}>
                Cancel
              </Button>
              <Button type="submit" loading={loading}>
                Create deal
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
