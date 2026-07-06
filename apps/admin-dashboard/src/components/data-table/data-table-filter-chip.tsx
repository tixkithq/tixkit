'use client';

import { X } from 'lucide-react';
import type { AdminTableFilterValue } from '@tixkit/admin-table-core';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type DataTableV2FilterChipProps = {
  label: string;
  value: AdminTableFilterValue;
  onRemove: () => void;
  className?: string;
};

export function DataTableV2FilterChip({
  label,
  value,
  onRemove,
  className,
}: DataTableV2FilterChipProps) {
  const displayValue = formatFilterValue(value);
  if (!displayValue) return null;

  return (
    <Badge variant="secondary" className={cn('gap-1 py-1 pl-2 pr-1 font-normal', className)}>
      <span className="text-muted-foreground">{label}:</span>
      <span>{displayValue}</span>
      <button
        type="button"
        onClick={onRemove}
        className="rounded-sm opacity-70 hover:opacity-100"
        aria-label={`Remove ${label} filter`}
      >
        <X className="size-3" />
      </button>
    </Badge>
  );
}

function formatFilterValue(value: AdminTableFilterValue): string {
  switch (value.type) {
    case 'text':
      return value.value.trim() || '';
    case 'select':
      return value.values.map((v) => v.replace(/_/g, ' ')).join(', ');
    case 'boolean':
      return value.value ? 'Yes' : 'No';
    case 'date_range': {
      const parts: string[] = [];
      if (value.from) parts.push(`from ${value.from}`);
      if (value.to) parts.push(`to ${value.to}`);
      return parts.join(' ');
    }
    case 'number_range': {
      const parts: string[] = [];
      if (value.min !== undefined) parts.push(`min ${value.min}`);
      if (value.max !== undefined) parts.push(`max ${value.max}`);
      return parts.join(' ');
    }
  }
}
