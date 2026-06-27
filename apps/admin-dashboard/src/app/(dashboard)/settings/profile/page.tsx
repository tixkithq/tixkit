'use client'

import * as React from 'react'
import { ExternalLink } from 'lucide-react'
import { useAdminUser } from '@/context/admin-user-provider'
import { hasClerkKey } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { GatedControl } from '@/components/gated-control'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { getDisplayNameInitials } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'

export default function ProfilePage() {
  const user = useAdminUser()
  const clerkEnabled = hasClerkKey()

  const openProfile = () => {
    window.open('/user', '_blank')
  }

  return (
    <div className='space-y-6'>
      <div className='space-y-1'>
        <h2 className='text-xl font-semibold tracking-tight'>Profile</h2>
        <p className='text-sm text-muted-foreground'>
          Your display name and contact details
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Personal Information</CardTitle>
          <CardDescription>
            {clerkEnabled
              ? 'Profile details are managed by Clerk. Click "Manage in Clerk" to update your name, email, avatar, and security settings.'
              : 'Profile details are managed by your identity provider. Configure Clerk to enable profile management.'}
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='flex items-center gap-4'>
            <Avatar className='size-16'>
              {user.imageUrl ? (
                <AvatarImage src={user.imageUrl} alt={user.name} />
              ) : null}
              <AvatarFallback className='text-lg'>
                {getDisplayNameInitials(user.name || '?')}
              </AvatarFallback>
            </Avatar>
            {clerkEnabled ? (
              <Button
                variant='outline'
                size='sm'
                onClick={openProfile}
              >
                <ExternalLink className='size-4' />
                Manage in Clerk
              </Button>
            ) : (
              <GatedControl
                variant='outline'
                size='sm'
                reason='Avatar changes are gated because Clerk authentication or a profile image upload endpoint is not configured.'
              >
                Change Avatar
              </GatedControl>
            )}
          </div>
          <div className='grid gap-4 sm:grid-cols-2'>
            <div className='space-y-2'>
              <Label htmlFor='name'>Display Name</Label>
              <Input
                id='name'
                value={user.name}
                readOnly
                className='bg-muted/50'
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='email'>Email</Label>
              <Input
                id='email'
                type='email'
                value={user.email}
                readOnly
                className='bg-muted/50'
              />
            </div>
          </div>
          {clerkEnabled ? (
            <Button onClick={() => window.open('/user', '_blank')}>
              <ExternalLink className='size-4' />
              Manage Profile in Clerk
            </Button>
          ) : (
            <GatedControl reason='Profile changes are gated because Clerk authentication or a profile update endpoint is not configured.'>
              Save Changes
            </GatedControl>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
