'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { adminApi } from '@/lib/api';
import { routes } from '@/lib/routes';
import { useBootstrap } from '@/context/bootstrap-provider';
import { useAdminQuery } from '@/hooks/use-admin-table-data';

/**
 * Keeps the sidebar workspace/brand scope aligned with the event being viewed.
 *
 * On open, the scope auto-aligns to the event's organization and brand so the
 * sidebar switcher always reflects the resource you are looking at. If the
 * scope is then changed manually to a brand that does not own this event, the
 * user is redirected back to the events list (filtered to the new brand).
 */
export function EventScopeGuard({
  eventId,
  children,
}: {
  eventId: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { organizationId, brandId, setOrganizationId, setBrandId } = useBootstrap();
  const { data: event, loading } = useAdminQuery(['getEvent', eventId], () => adminApi.getEvent(eventId));

  // Tracks the scope we most recently auto-aligned to, so we can distinguish
  // an auto-align from a manual switch and avoid a redirect race.
  const pendingAutoAlign = React.useRef<string | null>(null);

  // Auto-align the bootstrap scope to the event's org/brand when it loads.
  React.useEffect(() => {
    if (loading || !event || !event.organizationId || !event.brandId) return;
    if (event.organizationId !== organizationId || event.brandId !== brandId) {
      pendingAutoAlign.current = `${event.organizationId}:${event.brandId}`;
      setOrganizationId(event.organizationId);
      setBrandId(event.brandId);
    }
    // Intentionally not depending on organizationId/brandId so this only fires
    // when the event identity changes, not on every scope change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, loading]);

  // Guard: redirect to the events list when the scope no longer matches after
  // auto-align has settled (i.e. the user manually switched to another brand).
  React.useEffect(() => {
    if (loading || !event || !event.organizationId || !event.brandId) return;
    const alignedKey = `${event.organizationId}:${event.brandId}`;
    const currentKey = `${organizationId ?? ''}:${brandId ?? ''}`;

    // While an auto-align is pending (state has not propagated yet), wait for
    // it to settle instead of redirecting.
    if (pendingAutoAlign.current !== null) {
      if (pendingAutoAlign.current === currentKey) {
        pendingAutoAlign.current = null;
      }
      return;
    }

    if (currentKey !== alignedKey) {
      router.replace(routes.events);
    }
  }, [organizationId, brandId, event, loading, router]);

  return <>{children}</>;
}
