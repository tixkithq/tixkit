'use client';

import * as React from 'react';
import { type ApiResult, type AdminApiError } from '@/lib/api';

type UseAdminDataResult<T> = {
  data: T | undefined;
  loading: boolean;
  error: AdminApiError | undefined;
  refetch: () => void;
};

/**
 * Generic hook for fetching admin API data in client components.
 * Calls the provided fetcher on mount and whenever `deps` change.
 */
export function useAdminData<T>(
  fetcher: () => Promise<ApiResult<T>>,
  deps: React.DependencyList = [],
): UseAdminDataResult<T> {
  const [data, setData] = React.useState<T | undefined>(undefined);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<AdminApiError | undefined>(undefined);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    fetcher()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setData(result.data);
        } else {
          setError(result.error);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError({
          code: 'fetch_error',
          message: e instanceof Error ? e.message : 'Failed to fetch data',
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  const refetch = React.useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, refetch };
}
