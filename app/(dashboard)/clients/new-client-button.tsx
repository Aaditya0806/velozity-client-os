'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';

interface FieldErrors {
  [field: string]: string;
}

export function NewClientButton() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors({});
    setFormError(null);
    setLoading(true);

    const form = new FormData(event.currentTarget);
    const payload = {
      name: String(form.get('name') ?? '').trim(),
      legal_name: emptyToNull(form.get('legal_name')),
      industry: emptyToNull(form.get('industry')),
      website: emptyToNull(form.get('website')),
      lifecycle_stage: String(form.get('lifecycle_stage') ?? 'prospect'),
      internal_notes: emptyToNull(form.get('internal_notes')),
    };

    try {
      const response = await fetch('/api/v1/clients', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const body = (await response.json()) as {
        data?: { id: string; name: string };
        error?: { message: string; details?: { issues?: Array<{ path: string; message: string }> } };
        request_id: string;
      };

      if (!response.ok) {
        // Field errors are attached to their inputs; anything else is shown once
        // at the top with the request id, so support has something to search on.
        const issues = body.error?.details?.issues ?? [];
        if (issues.length > 0) {
          setErrors(Object.fromEntries(issues.map((i) => [i.path, i.message])));
        } else {
          setFormError(`${body.error?.message ?? 'Could not create this client.'} (${body.request_id})`);
        }
        setLoading(false);
        return;
      }

      toast.success(`${body.data?.name} created`);
      setOpen(false);
      setLoading(false);
      router.push(`/clients/${body.data?.id}`);
      router.refresh();
    } catch {
      setFormError('Could not reach the server. Please try again.');
      setLoading(false);
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        New client
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New client</DialogTitle>
            <DialogDescription>
              Add a company. You can fill in the rest from their record afterwards.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={submit} className="space-y-4" noValidate>
            {formError ? (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {formError}
              </p>
            ) : null}

            <Field label="Company name" name="name" required error={errors.name} autoFocus />
            <Field label="Legal name" name="legal_name" error={errors.legal_name} hint="If it differs from the trading name." />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Industry" name="industry" error={errors.industry} />
              <div className="space-y-1.5">
                <Label htmlFor="lifecycle_stage">Stage</Label>
                <select
                  id="lifecycle_stage"
                  name="lifecycle_stage"
                  defaultValue="prospect"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="prospect">Prospect</option>
                  <option value="client">Client</option>
                  <option value="partner">Partner</option>
                </select>
              </div>
            </div>

            <Field
              label="Website"
              name="website"
              type="url"
              placeholder="https://example.com"
              error={errors.website}
            />

            <div className="space-y-1.5">
              <Label htmlFor="internal_notes">Internal notes</Label>
              <Textarea
                id="internal_notes"
                name="internal_notes"
                rows={3}
                placeholder="Context that stays inside the team."
              />
              <p className="text-xs text-muted-foreground">
                Only visible to people with permission to read internal notes.
              </p>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={loading}>
                Cancel
              </Button>
              <Button type="submit" loading={loading}>
                Create client
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({
  label,
  name,
  error,
  hint,
  required,
  ...props
}: {
  label: string;
  name: string;
  error?: string;
  hint?: string;
  required?: boolean;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const describedBy = error ? `${name}-error` : hint ? `${name}-hint` : undefined;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={name} required={required}>
        {label}
      </Label>
      <Input id={name} name={name} aria-invalid={Boolean(error)} aria-describedby={describedBy} {...props} />
      {error ? (
        <p id={`${name}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${name}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}
