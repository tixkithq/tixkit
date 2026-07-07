'use client';

import * as React from 'react';
import { type AdminEventListItem, type AdminApiError, adminApi } from '@/lib/api';
import type { AdminTablePage } from '@tixkit/admin-table-core';

type UseAllEventsResult = {
  events: AdminEventListItem[];
  loading: boolean;
  error: AdminApiError | undefined;
  refetch: () => void;
};

/** Optional scope used to narrow the event query to a workspace and/or brand. */
type UseAllEventsScope = {
  organizationId?: string;
  brandId?: string;
};

const MAX_PAGES = 100;
const PAGE_SIZE = 50;

/**
 * Fetches all event pages by following the cursor until no more pages remain.
 * Used by selectors (Reports, Messages, Check-in) that need the complete list
 * rather than just the first API page of 50 items.
 *
 * When `scope` is provided, events are narrowed to the selected workspace/brand
 * and the hook re-fetches whenever the scope changes.
 */
export function useAllEvents(scope?: UseAllEventsScope): UseAllEventsResult {
  const { organizationId, brandId } = scope ?? {};
  const [events, setEvents] = React.useState<AdminEventListItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<AdminApiError | undefined>(undefined);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);

    (async () => {
      try {
        const all: AdminEventListItem[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < MAX_PAGES; i++) {
          const params: {
            cursor?: string;
            limit: number;
            organizationId?: string;
            brandId?: string;
          } = {
            cursor,
            limit: PAGE_SIZE,
          };
          if (organizationId) params.organizationId = organizationId;
          if (brandId) params.brandId = brandId;
          const result = await adminApi.listEvents(params);
          if (cancelled) return;
          if (!result.ok) {
            setError(result.error);
            setLoading(false);
            return;
          }
          const page = result.data as AdminTablePage<AdminEventListItem>;
          all.push(...page.items);
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        if (cancelled) return;
        setEvents(all);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        setError({
          code: 'fetch_error',
          message: e instanceof Error ? e.message : 'Failed to fetch events',
        });
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nonce, organizationId, brandId]);

  const refetch = React.useCallback(() => setNonce((n) => n + 1), []);

  return { events, loading, error, refetch };
}
