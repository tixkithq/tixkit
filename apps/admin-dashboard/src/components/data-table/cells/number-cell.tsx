'use client';

import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

type NumberCellProps = {
  value: number | null | undefined;
  className?: string;
};

export function NumberCell({ value, className }: NumberCellProps) {
  if (value === null || value === undefined) {
    return <span className={cn('text-sm text-muted-foreground', className)}>—</span>;
  }
  return (
    <span className={cn('text-sm tabular-nums', className)}>{formatNumber(value)}</span>
  );
}
