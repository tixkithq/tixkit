'use client'

import * as React from 'react'
import { Upload, ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/empty-state'
import { adminApi, type AdminBrand, type AdminBrandDomain } from '@/lib/api'
import { toast } from 'sonner'

export default function BrandingPage() {
  const [brand, setBrand] = React.useState<AdminBrand | null>(null)
  const [primaryColor, setPrimaryColor] = React.useState('#222222')
  const [domain, setDomain] = React.useState('')
  const [domains, setDomains] = React.useState<AdminBrandDomain[]>([])
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [addingDomain, setAddingDomain] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const loadBranding = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    const result = await adminApi.listBrands()
    if (!result.ok) {
      setBrand(null)
      setDomains([])
      setError(result.error.message)
      setLoading(false)
      return
    }

    const firstBrand = result.data[0] ?? null
    setBrand(firstBrand)
    setPrimaryColor(
      typeof firstBrand?.theme.primary === 'string'
        ? firstBrand.theme.primary
        : firstBrand?.theme.primaryColor ?? '#222222',
    )
    setDomains(firstBrand?.domains ?? [])
    setLoading(false)
  }, [])

  React.useEffect(() => {
    void loadBranding()
  }, [loadBranding])

  const handleAddDomain = async () => {
    if (!brand) {
      toast.error('No brand is available for domain configuration')
      return
    }

    const nextDomain = domain.trim().toLowerCase()
    if (!nextDomain) return

    setAddingDomain(true)
    const result = await adminApi.addBrandDomain(brand.id, nextDomain, domains.length === 0)
    setAddingDomain(false)

    if (!result.ok) {
      toast.error(result.error.message)
      return
    }

    setDomains((current) => [result.data, ...current])
    setDomain('')
    toast.success('Domain added')
  }

  const handleSave = async () => {
    if (!brand) {
      toast.error('No brand is available to update')
      return
    }

    setSaving(true)
    const result = await adminApi.updateBrand(brand.id, {
      theme: {
        ...brand.theme,
        primary: primaryColor,
      },
    })
    setSaving(false)

    if (!result.ok) {
      toast.error(result.error.message)
      return
    }

    setBrand(result.data)
    toast.success('Branding settings saved')
  }

  return (
    <div className='space-y-6'>
      <div className='space-y-1'>
        <h2 className='text-xl font-semibold tracking-tight'>Branding</h2>
        <p className='text-sm text-muted-foreground'>
          Logo, colors, domains, and event page defaults
        </p>
      </div>
      {loading ? (
        <Card>
          <CardContent className='p-4 text-sm text-muted-foreground'>
            Loading branding settings...
          </CardContent>
        </Card>
      ) : error ? (
        <EmptyState
          icon={ImageIcon}
          title='Branding settings unavailable'
          description={error}
          action={
            <Button variant='outline' onClick={() => void loadBranding()}>
              Retry
            </Button>
          }
        />
      ) : !brand ? (
        <EmptyState
          icon={ImageIcon}
          title='No brand found'
          description='Create a brand before configuring checkout branding.'
        />
      ) : (
      <>
      <Card>
        <CardHeader>
          <CardTitle>Logo</CardTitle>
          <CardDescription>
            Upload your organization logo for checkout pages and emails.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='flex items-center gap-4'>
            <div className='flex size-16 items-center justify-center rounded-lg border bg-muted'>
              <ImageIcon className='size-6 text-muted-foreground' />
            </div>
            <Button variant='outline'>
              <Upload className='size-4' />
              Upload Logo
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Brand Colors</CardTitle>
          <CardDescription>
            Set the primary color for your checkout pages and widgets.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='flex items-center gap-3'>
            <input
              type='color'
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              className='size-10 rounded-md border cursor-pointer'
            />
            <Input
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              className='w-32'
            />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Custom Domains</CardTitle>
          <CardDescription>
            Configure custom domains for your event pages and checkout.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='flex gap-2'>
            <Input
              placeholder='events.example.com'
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddDomain()
              }}
            />
            <Button onClick={handleAddDomain}>Add</Button>
          </div>
          {domains.length > 0 && (
            <div className='space-y-2'>
              {domains.map((d) => (
                <div
                  key={d.id}
                  className='flex items-center justify-between rounded-lg border p-3'
                >
                  <code className='text-sm font-mono'>{d.domain}</code>
                  <Badge variant={d.isVerified ? 'default' : 'secondary'}>
                    {d.isVerified ? 'verified' : d.sslStatus}
                  </Badge>
                </div>
              ))}
            </div>
          )}
          <Button onClick={handleSave} disabled={saving || addingDomain}>
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </CardContent>
      </Card>
      </>
      )}
    </div>
  )
}
