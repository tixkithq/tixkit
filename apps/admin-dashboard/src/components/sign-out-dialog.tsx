'use client';

import { useClerk } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { resetPrincipalCache } from '@/context/permission-provider';
import { hasClerkKey } from '@/lib/auth';
import { useRuntimeConfig } from '@/context/runtime-config-provider';

interface SignOutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SignOutDialog(props: SignOutDialogProps) {
  const runtimeConfig = useRuntimeConfig();
  return hasClerkKey(runtimeConfig) ? (
    <ClerkSignOutDialog {...props} />
  ) : (
    <LocalSignOutDialog {...props} />
  );
}

function ClerkSignOutDialog({ open, onOpenChange }: SignOutDialogProps) {
  const router = useRouter();
  const { signOut } = useClerk();

  const handleSignOut = () => {
    resetPrincipalCache();
    signOut(() => router.push('/sign-in'));
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Sign out"
      description="Are you sure you want to sign out? You will need to sign in again to access your account."
      confirmText="Sign out"
      variant="destructive"
      onConfirm={handleSignOut}
      className="sm:max-w-sm"
    />
  );
}

function LocalSignOutDialog({ open, onOpenChange }: SignOutDialogProps) {
  const handleSignOut = () => {
    resetPrincipalCache();
    onOpenChange(false);
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Sign out"
      description="Local development mode does not have a real session. Reload the page to continue."
      confirmText="Close"
      onConfirm={handleSignOut}
      className="sm:max-w-sm"
    />
  );
}
