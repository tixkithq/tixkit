'use client';

import * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { useAdminUser } from '@/context/admin-user-provider';
import { hasClerkKey } from '@/lib/auth';
import { useRuntimeConfig } from '@/context/runtime-config-provider';
import { Button } from '@/components/ui/button';
import { GatedControl } from '@/components/gated-control';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { getDisplayNameInitials } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

function openProfile() {
  window.open('/user', '_blank');
}

export default function ProfilePage() {
  const user = useAdminUser();
  const clerkEnabled = hasClerkKey(useRuntimeConfig());

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">Profile</h2>
        <p className="text-sm text-muted-foreground">Your display name and contact details</p>
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
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <Avatar className="size-16">
              {user.imageUrl ? <AvatarImage src={user.imageUrl} alt={user.name} /> : null}
              <AvatarFallback className="text-lg">
                {getDisplayNameInitials(user.name || '?')}
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-wrap items-center gap-2">
              {clerkEnabled ? (
                <Button variant="outline" size="sm" onClick={openProfile}>
                  <ExternalLink className="size-4" />
                  Manage in Clerk
                </Button>
              ) : null}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Display Name</Label>
              <div className="flex h-9 w-full min-w-0 items-center rounded-md border border-input bg-muted/50 px-3 py-1 text-base shadow-xs md:text-sm">
                {user.name}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <div className="flex h-9 w-full min-w-0 items-center rounded-md border border-input bg-muted/50 px-3 py-1 text-base shadow-xs md:text-sm">
                {user.email}
              </div>
            </div>
          </div>
          {clerkEnabled ? (
            <Button onClick={() => window.open('/user', '_blank')}>
              <ExternalLink className="size-4" />
              Manage Profile in Clerk
            </Button>
          ) : (
            <GatedControl reason="Profile changes are gated because Clerk authentication or a profile update endpoint is not configured.">
              Save Changes
            </GatedControl>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
