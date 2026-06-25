'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { EmptyState } from '@/components/empty-state'
import { adminApi, type AdminOrganization } from '@/lib/api'
import { Building2 } from 'lucide-react'
import { toast } from 'sonner'

export default function OrganizationPage() {
  const [organization, setOrganization] = React.useState<AdminOrganization | null>(null)
  const [name, setName] = React.useState('')
  const [slug, setSlug] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const loadOrganization = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    const result = await adminApi.listOrganizations()
    if (!result.ok) {
      setError(result.error.message)
      setOrganization(null)
      setLoading(false)
      return
    }

    const firstOrganization = result.data[0] ?? null
    setOrganization(firstOrganization)
    setName(firstOrganization?.name ?? '')
    setSlug(firstOrganization?.slug ?? '')
    setLoading(false)
  }, [])

  React.useEffect(() => {
    void loadOrganization()
  }, [loadOrganization])

  const handleSave = async () => {
    if (!organization) {
      toast.error('No organization is available to update')
      return
    }

    setSaving(true)
    const result = await adminApi.updateOrganization(organization.id, {
      name: name.trim(),
      slug: slug.trim(),
    })
    setSaving(false)

    if (!result.ok) {
      toast.error(result.error.message)
      return
    }

    setOrganization(result.data)
    toast.success('Organization settings saved')
  }

  return (
    <div className='space-y-6'>
      <div className='space-y-1'>
        <h2 className='text-xl font-semibold tracking-tight'>Organization</h2>
        <p className='text-sm text-muted-foreground'>
          Tenant and organization details
        </p>
      </div>
      {loading ? (
        <Card>
          <CardContent className='p-4 text-sm text-muted-foreground'>
            Loading organization settings...
          </CardContent>
        </Card>
      ) : error ? (
        <EmptyState
          icon={Building2}
          title='Organization settings unavailable'
          description={error}
          action={
            <Button variant='outline' onClick={() => void loadOrganization()}>
              Retry
            </Button>
          }
        />
      ) : !organization ? (
        <EmptyState
          icon={Building2}
          title='No organization found'
          description='Create an organization before editing organization settings.'
        />
      ) : (
      <Card>
        <CardHeader>
          <CardTitle>Organization Details</CardTitle>
          <CardDescription>
            Configure your persisted organization name and slug.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='grid gap-4 sm:grid-cols-2'>
            <div className='space-y-2'>
              <Label htmlFor='org-name'>Organization Name</Label>
              <Input
                id='org-name'
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='org-slug'>Slug</Label>
              <Input
                id='org-slug'
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
              />
            </div>
          </div>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </CardContent>
      </Card>
      )}
    </div>
  )
}
