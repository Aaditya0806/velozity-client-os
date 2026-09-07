import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/util/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'text-foreground',
        // Status tones. Kept muted so a dense table does not become a rainbow.
        success: 'border-transparent bg-[hsl(var(--success))]/12 text-[hsl(var(--success))]',
        warning: 'border-transparent bg-[hsl(var(--warning))]/12 text-[hsl(var(--warning))]',
        danger: 'border-transparent bg-destructive/12 text-destructive',
        info: 'border-transparent bg-[hsl(var(--info))]/12 text-[hsl(var(--info))]',
        neutral: 'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
