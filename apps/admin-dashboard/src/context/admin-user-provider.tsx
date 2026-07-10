'use client';

import { createContext, useContext, useMemo } from 'react';
import { useUser } from '@clerk/nextjs';
import { type AdminUser, LOCAL_DEV_USER, hasClerkKey, usesLocalDevAuth } from '@/lib/auth';

const AdminUserContext = createContext<AdminUser>(LOCAL_DEV_USER);
const UNAVAILABLE_ADMIN_USER: AdminUser = { name: '', email: '', imageUrl: null };

function ClerkUserProvider({ children }: { children: React.ReactNode }) {
  const { user, isLoaded, isSignedIn } = useUser();

  const value = useMemo<AdminUser>(
    () =>
      isLoaded && isSignedIn && user
        ? {
            name: user.fullName ?? user.firstName ?? 'User',
            email: user.primaryEmailAddress?.emailAddress ?? '',
            imageUrl: user.imageUrl ?? null,
          }
        : UNAVAILABLE_ADMIN_USER,
    [isLoaded, isSignedIn, user],
  );

  return <AdminUserContext value={value}>{children}</AdminUserContext>;
}

function LocalUserProvider({ children }: { children: React.ReactNode }) {
  return <AdminUserContext value={LOCAL_DEV_USER}>{children}</AdminUserContext>;
}

export function AdminUserProvider({ children }: { children: React.ReactNode }) {
  if (hasClerkKey()) return <ClerkUserProvider>{children}</ClerkUserProvider>;
  if (usesLocalDevAuth()) return <LocalUserProvider>{children}</LocalUserProvider>;
  return <AdminUserContext value={UNAVAILABLE_ADMIN_USER}>{children}</AdminUserContext>;
}

export const useAdminUser = () => useContext(AdminUserContext);
