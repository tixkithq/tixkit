'use client'

import * as React from 'react'
import { Wallet, CheckCircle2, Clock3, Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PermissionGuard } from '@/components/permission-guard'
import { EmptyState } from '@/components/empty-state'
import { GatedControl } from '@/components/gated-control'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { adminApi, type AdminOrganization, type AdminPaymentAccount, type AdminBrand } from '@/lib/api'
import { toast } from 'sonner'
import { useBootstrap } from '@/context/bootstrap-provider'

export default function PaymentsPage() {
  const {
    organizations,
    organizationId,
    availableBrands,
    brandId,
    setBrandId,
    loading: bootstrapLoading,
    error: bootstrapError,
  } = useBootstrap()
  const [organization, setOrganization] = React.useState<AdminOrganization | null>(null)
  const [accounts, setAccounts] = React.useState<AdminPaymentAccount[]>([])
  const [loading, setLoading] = React.useState(true)
  const [connecting, setConnecting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notConfigured, setNotConfigured] = React.useState(false)
  const [brands, setBrands] = React.useState<AdminBrand[]>([])
  const [selectedPaymentAccountId, setSelectedPaymentAccountId] = React.useState<string>('none')
  const [selectedBrandId, setSelectedBrandId] = React.useState<string>('')
  const [bindingBrand, setBindingBrand] = React.useState(false)

  const loadPayments = React.useCallback(async () => {
    if (bootstrapLoading) return

    setLoading(true)
    setError(null)
    setNotConfigured(false)

    if (bootstrapError) {
      setOrganization(null)
      setAccounts([])
      setBrands([])
      setSelectedBrandId('')
      setSelectedPaymentAccountId('none')
      setError(bootstrapError)
      setLoading(false)
      return
    }

    const selectedOrganization = organizations.find((org) => org.id === organizationId) ?? null
    setOrganization(selectedOrganization)
    if (!selectedOrganization) {
      setAccounts([])
      setBrands([])
      setSelectedBrandId('')
      setSelectedPaymentAccountId('none')
      setLoading(false)
      return
    }

    const accountsResult = await adminApi.listPaymentAccounts(selectedOrganization.id)
    if (!accountsResult.ok) {
      setAccounts([])
      setBrands([])
      setError(accountsResult.error.message)
      setLoading(false)
      return
    }

    setAccounts(accountsResult.data)
    setBrands(availableBrands)
    const selectedBrand = availableBrands.find((candidate) => candidate.id === brandId) ?? null
    setSelectedBrandId(selectedBrand?.id ?? '')
    setSelectedPaymentAccountId(selectedBrand?.paymentAccountId ?? 'none')

    setLoading(false)
  }, [availableBrands, bootstrapError, bootstrapLoading, brandId, organizationId, organizations])

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
      if (result.error.message.includes('not configured')) {
        setNotConfigured(true)
      }
      toast.error(result.error.message)
      return
    }

    setAccounts((current) => [result.data, ...current])
    setNotConfigured(false)
    toast.success('Payment account record created')
  }

  const handleBindPaymentAccount = async () => {
    const brand = brands.find((b) => b.id === selectedBrandId)
    if (!brand) {
      toast.error('Select a brand to bind a payment account')
      return
    }
    setBindingBrand(true)
    const result = await adminApi.updateBrand(brand.id, {
      paymentAccountId: selectedPaymentAccountId === 'none' ? null : selectedPaymentAccountId,
    })
    setBindingBrand(false)
    if (!result.ok) {
      toast.error(result.error.message)
      return
    }
    setBrands((current) =>
      current.map((b) =>
        b.id === brand.id ? { ...b, paymentAccountId: selectedPaymentAccountId === 'none' ? null : selectedPaymentAccountId } : b,
      ),
    )
    toast.success('Payment account binding updated')
  }

  const handleBrandChange = (nextBrandId: string) => {
    setSelectedBrandId(nextBrandId)
    setBrandId(nextBrandId)
    const brand = brands.find((b) => b.id === nextBrandId)
    setSelectedPaymentAccountId(brand?.paymentAccountId ?? 'none')
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
          {bootstrapLoading || loading ? (
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
              title='Select an organization'
              description='Choose an organization from the workspace selector before configuring payment providers.'
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
              {!isActive ? (
                <GatedControl
                  variant='outline'
                  reason='Stripe onboarding links are gated because the current admin API only creates the payment account record and does not expose an onboarding URL endpoint.'
                >
                  Continue Onboarding
                </GatedControl>
              ) : null}
            </div>
          ) : notConfigured ? (
            <div className='space-y-4'>
              <div className='flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4'>
                <Clock3 className='size-5 text-amber-600 dark:text-amber-400' />
                <div>
                  <p className='font-medium'>Stripe Connect onboarding is not configured</p>
                  <p className='text-sm text-muted-foreground'>
                    This environment does not have Stripe Connect onboarding enabled.
                    Configure <code className='font-mono'>STRIPE_SECRET_KEY</code> on the
                    backend to enable Connect account creation and onboarding links.
                  </p>
                </div>
              </div>
              <Button variant='outline' onClick={handleConnect} disabled={connecting}>
                <Wallet className='size-4' />
                {connecting ? 'Connecting...' : 'Retry Connection'}
              </Button>
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
      {accounts.length > 0 && brands.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Brand Payment Routing</CardTitle>
            <CardDescription>
              Bind a payment account to a brand for paid checkout routing.
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='space-y-2'>
                <label htmlFor='brand-select' className='text-sm font-medium'>Brand</label>
                <Select
                  value={selectedBrandId}
                  onValueChange={handleBrandChange}
                >
                  <SelectTrigger id='brand-select' className='w-full'>
                    <SelectValue placeholder='Select a brand' />
                  </SelectTrigger>
                  <SelectContent>
                    {brands.map((brand) => (
                      <SelectItem key={brand.id} value={brand.id}>
                        {brand.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className='space-y-2'>
                <label htmlFor='payment-account-select' className='text-sm font-medium'>Payment Account</label>
                <Select
                  value={selectedPaymentAccountId}
                  onValueChange={setSelectedPaymentAccountId}
                >
                  <SelectTrigger id='payment-account-select' className='w-full'>
                    <SelectValue placeholder='Select a payment account' />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='none'>No payment account</SelectItem>
                    {accounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.provider} - {account.providerAccountId} ({account.status})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button onClick={handleBindPaymentAccount} disabled={bindingBrand || !selectedBrandId}>
              <Link2 className='size-4' />
              {bindingBrand ? 'Saving...' : 'Save Binding'}
            </Button>
          </CardContent>
        </Card>
      )}
      </div>
    </PermissionGuard>
  )
}
