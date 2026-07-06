'use client';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

type BadgeCellProps = {
  value: string | null | undefined;
  variant?: 'default' | 'secondary' | 'destructive' | 'outline';
  className?: string;
};

export function BadgeCell({ value, variant = 'secondary', className }: BadgeCellProps) {
  if (!value) {
    return <span className={cn('text-sm text-muted-foreground', className)}>—</span>;
  }
  return (
    <Badge variant={variant} className={cn('font-normal', className)}>
      {value}
    </Badge>
  );
}
