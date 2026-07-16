'use client';

import { UserProfile, useClerk } from '@clerk/nextjs';
import { hasClerkKey } from '@/lib/auth';
import { useRuntimeConfig } from '@/context/runtime-config-provider';

export default function UserProfilePage() {
  const clerk = useClerk();
  const runtimeConfig = useRuntimeConfig();

  if (!hasClerkKey(runtimeConfig)) {
    return (
      <div className="flex min-h-svh items-center justify-center p-8">
        <div className="text-center space-y-2">
          <h1 className="text-xl font-semibold">Profile Management</h1>
          <p className="text-sm text-muted-foreground">
            Clerk is not configured. Profile management is available when authentication is enabled.
          </p>
        </div>
      </div>
    );
  }

  // Open Clerk's hosted UserProfile via the client API as a safer alternative
  // to rendering <UserProfile /> directly (which requires specific routing
  // configuration). Falls back to the embedded component.
  if (clerk?.openUserProfile) {
    clerk.openUserProfile();
    return (
      <div className="flex min-h-svh items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">Opening profile...</p>
      </div>
    );
  }

  return <UserProfile routing="path" path="/user" />;
}
