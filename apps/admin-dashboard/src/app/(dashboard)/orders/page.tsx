import { OrdersTable } from '@/features/orders/orders-table'

export default function Page() {
  return (
    <div className='space-y-6'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='space-y-1'>
          <h1 className='text-2xl font-bold tracking-tight'>Orders</h1>
          <p className='text-sm text-muted-foreground'>
            Track payments, refunds, and attendee purchases
          </p>
        </div>
      </div>
      <OrdersTable />
    </div>
  )
}
