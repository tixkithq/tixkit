'use client';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

type StatusPreset = {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
};

type StatusDomain = 'order' | 'ticket' | 'payment' | 'checkin' | 'webhook' | 'export';

const STATUS_PRESETS: Record<StatusDomain, Record<string, StatusPreset>> = {
  order: {
    pending: { label: 'Pending', variant: 'outline' },
    paid: { label: 'Paid', variant: 'default' },
    failed: { label: 'Failed', variant: 'destructive' },
    cancelled: { label: 'Cancelled', variant: 'secondary' },
    refunded: { label: 'Refunded', variant: 'secondary' },
    partially_refunded: { label: 'Partially Refunded', variant: 'secondary' },
  },
  ticket: {
    active: { label: 'Active', variant: 'default' },
    cancelled: { label: 'Cancelled', variant: 'destructive' },
    refunded: { label: 'Refunded', variant: 'secondary' },
    transferred: { label: 'Transferred', variant: 'outline' },
  },
  payment: {
    pending: { label: 'Pending', variant: 'outline' },
    succeeded: { label: 'Succeeded', variant: 'default' },
    failed: { label: 'Failed', variant: 'destructive' },
    refunded: { label: 'Refunded', variant: 'secondary' },
  },
  checkin: {
    not_checked_in: { label: 'Not Checked In', variant: 'outline' },
    checked_in: { label: 'Checked In', variant: 'default' },
    duplicate: { label: 'Duplicate', variant: 'destructive' },
    revoked: { label: 'Revoked', variant: 'destructive' },
  },
  webhook: {
    pending: { label: 'Pending', variant: 'outline' },
    delivered: { label: 'Delivered', variant: 'default' },
    failed: { label: 'Failed', variant: 'destructive' },
    retrying: { label: 'Retrying', variant: 'secondary' },
  },
  export: {
    pending: { label: 'Pending', variant: 'outline' },
    processing: { label: 'Processing', variant: 'secondary' },
    completed: { label: 'Completed', variant: 'default' },
    failed: { label: 'Failed', variant: 'destructive' },
  },
};

type StatusCellProps = {
  value: string | null | undefined;
  domain: StatusDomain;
  className?: string;
};

export function StatusCell({ value, domain, className }: StatusCellProps) {
  if (!value) {
    return <span className={cn('text-sm text-muted-foreground', className)}>—</span>;
  }
  const preset = STATUS_PRESETS[domain]?.[value];
  if (!preset) {
    return (
      <Badge variant="secondary" className={cn('font-normal capitalize', className)}>
        {value.replace(/_/g, ' ')}
      </Badge>
    );
  }
  return (
    <Badge variant={preset.variant} className={cn('font-normal', className)}>
      {preset.label}
    </Badge>
  );
}

export { STATUS_PRESETS };
export type { StatusDomain, StatusPreset };
