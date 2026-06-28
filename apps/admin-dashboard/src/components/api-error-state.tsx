'use client';

import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AdminApiError } from '@/lib/api';

type ApiErrorStateProps = {
  error: AdminApiError;
  onRetry?: () => void;
  title?: string;
  className?: string;
};

/**
 * Displays a real error state when an API call fails. This replaces the
 * previous behavior of rendering fake empty states on auth/API failures.
 */
export function ApiErrorState({ error, onRetry, title, className }: ApiErrorStateProps) {
  const isAuth = error.status === 401 || error.status === 403;
  const displayTitle =
    title ??
    (isAuth
      ? 'Authentication required'
      : error.status === 500
        ? 'Server error'
        : error.code === 'timeout'
          ? 'Request timed out'
          : error.code === 'network_error'
            ? 'Network error'
            : 'Unable to load data');

  const displayMessage = isAuth
    ? 'Your session may have expired. Please refresh the page or sign in again.'
    : error.message || 'An unexpected error occurred. Please try again.';

  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center ${className ?? ''}`}
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10">
        <AlertCircle className="size-5 text-destructive" />
      </div>
      <div className="space-y-1">
        <p className="font-medium text-destructive">{displayTitle}</p>
        <p className="text-sm text-muted-foreground">{displayMessage}</p>
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-2 gap-1.5">
          <RefreshCw className="size-3.5" />
          Try again
        </Button>
      ) : null}
    </div>
  );
}
