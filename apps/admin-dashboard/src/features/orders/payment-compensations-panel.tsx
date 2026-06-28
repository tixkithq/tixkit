'use client';

import * as React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { adminApi, type AdminPaymentCompensation } from '@/lib/api';
import { formatCurrency } from '@/lib/format';
import { useAdminData } from '@/hooks/use-admin-data';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function PaymentCompensationsPanel() {
  const { data, loading, error, refetch } = useAdminData(() =>
    adminApi.listPaymentCompensations({ status: 'manual_review', limit: 5 }),
  );
  const compensations = data?.items ?? [];

  if (loading) return <Skeleton className="h-24 w-full" />;
  if (error || compensations.length === 0) return null;

  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Payment compensation needs review</AlertTitle>
      <AlertDescription className="mt-3 space-y-3">
        {compensations.map((compensation) => (
          <CompensationRow key={compensation.id} compensation={compensation} />
        ))}
        <Button type="button" variant="outline" size="sm" onClick={refetch}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function CompensationRow({ compensation }: { compensation: AdminPaymentCompensation }) {
  return (
    <div className="grid gap-2 rounded-md border border-destructive/30 bg-background/80 p-3 text-sm text-foreground md:grid-cols-[1fr_auto]">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="destructive">{compensation.status}</Badge>
          <span className="font-medium">
            {formatCurrency(compensation.amountCents, compensation.currency)}
          </span>
          <span className="text-muted-foreground">
            {compensation.provider} {compensation.action}
          </span>
        </div>
        <p className="text-muted-foreground">{compensation.reason}</p>
        {compensation.lastError ? (
          <p className="text-destructive">{compensation.lastError}</p>
        ) : null}
      </div>
      <div className="space-y-1 text-xs text-muted-foreground md:text-right">
        <p>Session {compensation.checkoutSessionId}</p>
        <p>Provider intent {compensation.providerIntentId}</p>
        <p>Attempts {compensation.attempts}</p>
      </div>
    </div>
  );
}
