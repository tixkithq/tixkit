'use client';

import { CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { type CheckInScanResult } from '@/lib/api';
import { cn } from '@/lib/utils';

const RESULT_CONFIG = {
  accepted: {
    icon: CheckCircle2,
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  },
  duplicate: {
    icon: AlertCircle,
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
  invalid: {
    icon: XCircle,
    className: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
  },
  revoked: {
    icon: XCircle,
    className: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
  },
  wrong_event: {
    icon: AlertCircle,
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
  wrong_list: {
    icon: AlertCircle,
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
} as const satisfies Record<CheckInScanResult['status'], unknown>;

export function ScanResult({ result }: { result: CheckInScanResult }) {
  const { icon: Icon, className } = RESULT_CONFIG[result.status];

  return (
    <output
      aria-live="polite"
      aria-atomic="true"
      className={cn('flex items-start gap-3 rounded-lg border p-4', className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <span className="space-y-1">
        <span className="block font-medium capitalize">{result.status.replace(/_/g, ' ')}</span>
        <span className="block text-sm">
          {result.status === 'accepted'
            ? result.attendee
              ? `${result.attendee.name} has been checked in.`
              : (result.message ?? 'Check-in successful')
            : result.message}
        </span>
        {result.attendee && result.status !== 'accepted' && (
          <span className="block text-xs text-muted-foreground">
            Attendee: {result.attendee.name} ({result.attendee.ticketTypeName})
          </span>
        )}
      </span>
    </output>
  );
}
