'use client';

import { Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type BooleanCellProps = {
  value: boolean | null | undefined;
  trueLabel?: string;
  falseLabel?: string;
  className?: string;
};

export function BooleanCell({
  value,
  trueLabel,
  falseLabel,
  className,
}: BooleanCellProps) {
  if (value === null || value === undefined) {
    return <span className={cn('text-sm text-muted-foreground', className)}>—</span>;
  }

  if (trueLabel || falseLabel) {
    return (
      <span className={cn('text-sm', className)}>
        {value ? (trueLabel ?? 'Yes') : (falseLabel ?? 'No')}
      </span>
    );
  }

  return value ? (
    <Check className={cn('size-4 text-green-600', className)} aria-label="Yes" />
  ) : (
    <X className={cn('size-4 text-muted-foreground', className)} aria-label="No" />
  );
}
