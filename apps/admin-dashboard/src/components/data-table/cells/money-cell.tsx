'use client';

import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';

type MoneyCellProps = {
  /** Amount in cents. */
  cents: number | null | undefined;
  currency?: string;
  className?: string;
};

export function MoneyCell({ cents, currency = 'USD', className }: MoneyCellProps) {
  if (cents === null || cents === undefined) {
    return <span className={cn('text-sm text-muted-foreground', className)}>—</span>;
  }
  return (
    <span className={cn('text-sm tabular-nums font-medium', className)}>
      {formatCurrency(cents, currency)}
    </span>
  );
}
