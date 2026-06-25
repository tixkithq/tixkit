'use client'

import * as React from 'react'
import { useAdminUser } from '@/context/admin-user-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { getDisplayNameInitials } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'

export default function ProfilePage() {
  const user = useAdminUser()
  const [name, setName] = React.useState(user.name)
  const [email, setEmail] = React.useState(user.email)

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
            Update your personal profile information.
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
            <Button variant='outline' size='sm' disabled>
              Change Avatar
            </Button>
          </div>
          <div className='grid gap-4 sm:grid-cols-2'>
            <div className='space-y-2'>
              <Label htmlFor='name'>Display Name</Label>
              <Input
                id='name'
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='email'>Email</Label>
              <Input
                id='email'
                type='email'
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </div>
          <Button disabled>Save Changes</Button>
        </CardContent>
      </Card>
    </div>
  )
}
