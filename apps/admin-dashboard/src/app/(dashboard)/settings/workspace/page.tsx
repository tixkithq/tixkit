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
import { useBootstrap } from '@/context/bootstrap-provider'

export default function OrganizationPage() {
  const { organizations, organizationId, loading: bootstrapLoading, error: bootstrapError } = useBootstrap()
  const [organization, setOrganization] = React.useState<AdminOrganization | null>(null)
  const [name, setName] = React.useState('')
  const [slug, setSlug] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (bootstrapLoading) return

    if (bootstrapError) {
      setError(bootstrapError)
      setOrganization(null)
      setName('')
      setSlug('')
      return
    }

    const selectedOrganization = organizations.find((org) => org.id === organizationId) ?? null
    setError(null)
    setOrganization(selectedOrganization)
    setName(selectedOrganization?.name ?? '')
    setSlug(selectedOrganization?.slug ?? '')
  }, [bootstrapError, bootstrapLoading, organizationId, organizations])

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
      {bootstrapLoading ? (
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
        />
      ) : !organization ? (
        <EmptyState
          icon={Building2}
          title='Select an organization'
          description='Choose an organization from the workspace selector before editing organization settings.'
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
