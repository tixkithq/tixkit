'use client'

import * as React from 'react'
import { CreditCard, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/empty-state'
import { adminApi, type AdminBillingOverview, type AdminOrganization } from '@/lib/api'

export default function BillingPage() {
  const [organization, setOrganization] = React.useState<AdminOrganization | null>(null)
  const [billing, setBilling] = React.useState<AdminBillingOverview | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const loadBilling = React.useCallback(async () => {
    setLoading(true)
    setError(null)

    const organizationsResult = await adminApi.listOrganizations()
    if (!organizationsResult.ok) {
      setOrganization(null)
      setBilling(null)
      setError(organizationsResult.error.message)
      setLoading(false)
      return
    }

    const firstOrganization = organizationsResult.data[0] ?? null
    setOrganization(firstOrganization)
    if (!firstOrganization) {
      setBilling(null)
      setLoading(false)
      return
    }

    const billingResult = await adminApi.getBillingOverview(firstOrganization.id)
    if (!billingResult.ok) {
      setBilling(null)
      setError(billingResult.error.message)
      setLoading(false)
      return
    }

    setBilling(billingResult.data)
    setLoading(false)
  }, [])

  React.useEffect(() => {
    void loadBilling()
  }, [loadBilling])

  const plan = billing?.plan ?? 'No plan reported'
  const status = billing?.status ?? 'unavailable'
  const usage = billing?.ticketLimit
    ? `${billing.ticketsThisMonth ?? 0} / ${billing.ticketLimit}`
    : 'Unavailable'

  return (
    <div className='space-y-6'>
      <div className='space-y-1'>
        <h2 className='text-xl font-semibold tracking-tight'>Billing</h2>
        <p className='text-sm text-muted-foreground'>
          Plan and invoices
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Current Plan</CardTitle>
          <CardDescription>
            Your subscription plan and usage.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-4'>
          {loading ? (
            <p className='text-sm text-muted-foreground'>Loading billing settings...</p>
          ) : error ? (
            <EmptyState
              icon={CreditCard}
              title='Billing settings unavailable'
              description={error}
              action={
                <Button variant='outline' onClick={() => void loadBilling()}>
                  Retry
                </Button>
              }
            />
          ) : !organization ? (
            <EmptyState
              icon={CreditCard}
              title='No organization found'
              description='Create an organization before viewing billing.'
            />
          ) : (
          <>
          <div className='flex items-center justify-between rounded-lg border p-4'>
            <div className='flex items-center gap-3'>
              <CreditCard className='size-5 text-muted-foreground' />
              <div>
                <p className='font-medium'>{plan}</p>
                <p className='text-sm text-muted-foreground'>
                  Billing status from the GateKit API
                </p>
              </div>
            </div>
            <Badge variant={status === 'active' ? 'default' : 'secondary'}>{status}</Badge>
          </div>
          <div className='grid gap-4 sm:grid-cols-3'>
            <div className='rounded-lg border p-4'>
              <p className='text-sm text-muted-foreground'>Tickets This Month</p>
              <p className='text-2xl font-bold'>{usage}</p>
            </div>
            <div className='rounded-lg border p-4'>
              <p className='text-sm text-muted-foreground'>Next Billing Date</p>
              <p className='text-2xl font-bold'>{billing?.nextBillingDate ?? 'Unavailable'}</p>
            </div>
            <div className='rounded-lg border p-4'>
              <p className='text-sm text-muted-foreground'>Payment Method</p>
              <p className='text-2xl font-bold'>{billing?.paymentMethodLabel ?? 'Unavailable'}</p>
            </div>
          </div>
          <Button variant='outline' disabled>
            <Download className='size-4' />
            Download Invoices
          </Button>
          </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
