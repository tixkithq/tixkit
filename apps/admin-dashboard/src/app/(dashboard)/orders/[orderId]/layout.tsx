import { OrderScopeGuard } from '@/features/orders/order-scope-guard';

export default async function OrderLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  return <OrderScopeGuard orderId={orderId}>{children}</OrderScopeGuard>;
}
