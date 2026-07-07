'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { adminApi } from '@/lib/api';
import { routes } from '@/lib/routes';
import { useBootstrap } from '@/context/bootstrap-provider';
import { useAdminQuery } from '@/hooks/use-admin-table-data';

/**
 * Keeps the sidebar workspace/brand scope aligned with the order being viewed.
 *
 * On open, the scope auto-aligns to the order's organization and brand. If the
 * scope is then changed manually to a brand that does not own this order, the
 * user is redirected back to the orders list.
 */
export function OrderScopeGuard({
  orderId,
  children,
}: {
  orderId: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { organizationId, brandId, setOrganizationId, setBrandId } = useBootstrap();
  const { data: order, loading } = useAdminQuery(['getOrder', orderId], () =>
    adminApi.getOrder(orderId),
  );

  const pendingAutoAlign = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (loading || !order || !order.organizationId || !order.brandId) return;
    if (order.organizationId !== organizationId || order.brandId !== brandId) {
      pendingAutoAlign.current = `${order.organizationId}:${order.brandId}`;
      setOrganizationId(order.organizationId);
      setBrandId(order.brandId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, loading]);

  React.useEffect(() => {
    if (loading || !order || !order.organizationId || !order.brandId) return;
    const alignedKey = `${order.organizationId}:${order.brandId}`;
    const currentKey = `${organizationId ?? ''}:${brandId ?? ''}`;

    if (pendingAutoAlign.current !== null) {
      if (pendingAutoAlign.current === currentKey) {
        pendingAutoAlign.current = null;
      }
      return;
    }

    if (currentKey !== alignedKey) {
      router.replace(routes.orders);
    }
  }, [organizationId, brandId, order, loading, router]);

  return <>{children}</>;
}
