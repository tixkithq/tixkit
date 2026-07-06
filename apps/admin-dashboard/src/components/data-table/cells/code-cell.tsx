'use client';

import { cn } from '@/lib/utils';

type CodeCellProps = {
  value: string | null | undefined;
  className?: string;
  maxLength?: number;
};

export function CodeCell({ value, className, maxLength }: CodeCellProps) {
  if (!value) {
    return <span className={cn('text-sm text-muted-foreground', className)}>—</span>;
  }
  const display = maxLength && value.length > maxLength
    ? `${value.slice(0, maxLength)}…`
    : value;
  return (
    <code className={cn('font-mono text-xs font-medium', className)} title={value}>
      {display}
    </code>
  );
}
