'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const PRESETS = [
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 12 months', days: 365 },
];

export function ReportFilters({ from, to }: { from: string; to: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [start, setStart] = React.useState(from);
  const [end, setEnd] = React.useState(to);

  const apply = (nextFrom: string, nextTo: string) => {
    const next = new URLSearchParams(params.toString());
    next.set('from', nextFrom);
    next.set('to', nextTo);
    router.push(`/reports?${next.toString()}`);
  };

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
      <div className="space-y-1.5">
        <Label htmlFor="report-from">From</Label>
        <Input
          id="report-from"
          type="date"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="w-40"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="report-to">To</Label>
        <Input
          id="report-to"
          type="date"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          className="w-40"
        />
      </div>
      <Button onClick={() => apply(start, end)}>Apply</Button>

      <div className="flex flex-wrap gap-1 sm:ml-auto">
        {PRESETS.map((preset) => (
          <Button
            key={preset.days}
            variant="ghost"
            size="sm"
            onClick={() => {
              const nextTo = new Date().toISOString().slice(0, 10);
              const nextFrom = new Date(Date.now() - preset.days * 86_400_000)
                .toISOString()
                .slice(0, 10);
              setStart(nextFrom);
              setEnd(nextTo);
              apply(nextFrom, nextTo);
            }}
          >
            {preset.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
