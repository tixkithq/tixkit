'use client';

import { cn } from '@/lib/utils';

type TextCellProps = {
  value: string | null | undefined;
  className?: string;
  fallback?: string;
};

export function TextCell({ value, className, fallback = '—' }: TextCellProps) {
  if (value === null || value === undefined || value === '') {
    return <span className={cn('text-sm text-muted-foreground', className)}>{fallback}</span>;
  }
  return <span className={cn('text-sm', className)}>{value}</span>;
}
