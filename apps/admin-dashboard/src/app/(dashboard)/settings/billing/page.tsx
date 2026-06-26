'use client'

import * as React from 'react'
import { CreditCard, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/empty-state'
import { GatedControl } from '@/components/gated-control'
import { adminApi, type AdminBillingOverview, type AdminOrganization } from '@/lib/api'
import { useBootstrap } from '@/context/bootstrap-provider'

export default function BillingPage() {
  const { organizations, organizationId, loading: bootstrapLoading, error: bootstrapError } = useBootstrap()
  const [organization, setOrganization] = React.useState<AdminOrganization | null>(null)
  const [billing, setBilling] = React.useState<AdminBillingOverview | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const loadBilling = React.useCallback(async () => {
    if (bootstrapLoading) return

    setLoading(true)
    setError(null)

    if (bootstrapError) {
      setOrganization(null)
      setBilling(null)
      setError(bootstrapError)
      setLoading(false)
      return
    }

    const selectedOrganization = organizations.find((org) => org.id === organizationId) ?? null
    setOrganization(selectedOrganization)
    if (!selectedOrganization) {
      setBilling(null)
      setLoading(false)
      return
    }

    const billingResult = await adminApi.getBillingOverview(selectedOrganization.id)
    if (!billingResult.ok) {
      setBilling(null)
      setError(billingResult.error.message)
      setLoading(false)
      return
    }

    setBilling(billingResult.data)
    setLoading(false)
  }, [bootstrapError, bootstrapLoading, organizationId, organizations])

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
          {bootstrapLoading || loading ? (
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
              title='Select an organization'
              description='Choose an organization from the workspace selector before viewing billing.'
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
          <GatedControl
            variant='outline'
            reason='Invoice downloads are gated because the admin API does not expose an invoice download endpoint yet.'
          >
            <Download className='size-4' />
            Download Invoices
          </GatedControl>
          </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
