import { OrderDetailView } from '@/features/orders/order-detail-view'

export default async function Page({
  params,
}: {
  params: Promise<{ orderId: string }>
}) {
  const { orderId } = await params
  return <OrderDetailView orderId={orderId} />
}
