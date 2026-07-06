'use client';

import { formatDate, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

type TimestampCellProps = {
  value: string | Date | null | undefined;
  showRelative?: boolean;
  showTime?: boolean;
  className?: string;
};

function formatRelative(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return formatDate(date);
}

export function TimestampCell({
  value,
  showRelative = false,
  showTime = false,
  className,
}: TimestampCellProps) {
  if (!value) {
    return <span className={cn('text-sm text-muted-foreground', className)}>—</span>;
  }

  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return <span className={cn('text-sm text-muted-foreground', className)}>—</span>;
  }

  if (showRelative) {
    return (
      <span className={cn('text-sm text-muted-foreground', className)} title={formatDateTime(date)}>
        {formatRelative(date)}
      </span>
    );
  }

  return (
    <span className={cn('text-sm', className)}>
      {showTime ? formatDateTime(date) : formatDate(date)}
    </span>
  );
}
