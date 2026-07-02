import { PermissionGuard } from '@/components/permission-guard';
import { OrderDetailView } from '@/features/orders/order-detail-view';

export default async function Page({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  return (
    <PermissionGuard required="orders.read">
      <OrderDetailView orderId={orderId} />
    </PermissionGuard>
  );
}
