'use client'

import * as React from 'react'
import { Wallet, CheckCircle2, Clock3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PermissionGuard } from '@/components/permission-guard'
import { EmptyState } from '@/components/empty-state'
import { adminApi, type AdminOrganization, type AdminPaymentAccount } from '@/lib/api'
import { toast } from 'sonner'

export default function PaymentsPage() {
  const [organization, setOrganization] = React.useState<AdminOrganization | null>(null)
  const [accounts, setAccounts] = React.useState<AdminPaymentAccount[]>([])
  const [loading, setLoading] = React.useState(true)
  const [connecting, setConnecting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const loadPayments = React.useCallback(async () => {
    setLoading(true)
    setError(null)

    const organizationsResult = await adminApi.listOrganizations()
    if (!organizationsResult.ok) {
      setOrganization(null)
      setAccounts([])
      setError(organizationsResult.error.message)
      setLoading(false)
      return
    }

    const firstOrganization = organizationsResult.data[0] ?? null
    setOrganization(firstOrganization)
    if (!firstOrganization) {
      setAccounts([])
      setLoading(false)
      return
    }

    const accountsResult = await adminApi.listPaymentAccounts(firstOrganization.id)
    if (!accountsResult.ok) {
      setAccounts([])
      setError(accountsResult.error.message)
      setLoading(false)
      return
    }

    setAccounts(accountsResult.data)
    setLoading(false)
  }, [])

  React.useEffect(() => {
    void loadPayments()
  }, [loadPayments])

  const handleConnect = async () => {
    if (!organization) {
      toast.error('Create an organization before connecting Stripe')
      return
    }

    setConnecting(true)
    const result = await adminApi.createStripeConnectAccount(organization.id)
    setConnecting(false)

    if (!result.ok) {
      toast.error(result.error.message)
      return
    }

    setAccounts((current) => [result.data, ...current])
    toast.success('Payment account record created')
  }

  const connectedAccount = accounts.find((account) => account.provider === 'stripe_connect' || account.provider === 'stripe')
  const isActive = connectedAccount?.status === 'active'

  return (
    <PermissionGuard required='billing.write'>
      <div className='space-y-6'>
      <div className='space-y-1'>
        <h2 className='text-xl font-semibold tracking-tight'>Payments</h2>
        <p className='text-sm text-muted-foreground'>
          Stripe Connect and provider settings
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Stripe Connect</CardTitle>
          <CardDescription>
            Connect your Stripe account to accept payments for paid events.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-4'>
          {loading ? (
            <p className='text-sm text-muted-foreground'>Loading payment settings...</p>
          ) : error ? (
            <EmptyState
              icon={Wallet}
              title='Payment settings unavailable'
              description={error}
              action={
                <Button variant='outline' onClick={() => void loadPayments()}>
                  Retry
                </Button>
              }
            />
          ) : !organization ? (
            <EmptyState
              icon={Wallet}
              title='No organization found'
              description='Create an organization before configuring payment providers.'
            />
          ) : connectedAccount ? (
            <div className='space-y-4'>
              <div className={isActive ? 'flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4' : 'flex items-center gap-3 rounded-lg border p-4'}>
                {isActive ? (
                  <CheckCircle2 className='size-5 text-emerald-600 dark:text-emerald-400' />
                ) : (
                  <Clock3 className='size-5 text-muted-foreground' />
                )}
                <div className='flex-1'>
                  <p className='font-medium'>Stripe {connectedAccount.status}</p>
                  <p className='text-sm text-muted-foreground'>
                    Account ID: <code className='font-mono'>{connectedAccount.providerAccountId}</code>
                  </p>
                  {!isActive ? (
                    <p className='mt-1 text-sm text-muted-foreground'>
                      Onboarding is not complete until the API returns an active provider account.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className='space-y-4'>
              <div className='flex items-center gap-3 rounded-lg border p-4'>
                <Wallet className='size-5 text-muted-foreground' />
                <div>
                  <p className='font-medium'>No payment provider connected</p>
                  <p className='text-sm text-muted-foreground'>
                    Connect Stripe to accept payments for paid events.
                  </p>
                </div>
              </div>
              <Button onClick={handleConnect} disabled={connecting}>
                <Wallet className='size-4' />
                {connecting ? 'Connecting...' : 'Connect Stripe'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      </div>
    </PermissionGuard>
  )
}
