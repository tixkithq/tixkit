'use client'

import { createContext, useContext } from 'react'
import { useUser } from '@clerk/nextjs'
import {
  type AdminUser,
  LOCAL_DEV_USER,
  hasClerkKey,
} from '@/lib/auth'

const AdminUserContext = createContext<AdminUser>(LOCAL_DEV_USER)

function ClerkUserProvider({ children }: { children: React.ReactNode }) {
  const { user, isLoaded, isSignedIn } = useUser()

  const value: AdminUser =
    isLoaded && isSignedIn && user
      ? {
          name: user.fullName ?? user.firstName ?? 'User',
          email: user.primaryEmailAddress?.emailAddress ?? '',
          imageUrl: user.imageUrl ?? null,
        }
      : { name: '', email: '', imageUrl: null }

  return (
    <AdminUserContext value={value}>{children}</AdminUserContext>
  )
}

function LocalUserProvider({ children }: { children: React.ReactNode }) {
  return (
    <AdminUserContext value={LOCAL_DEV_USER}>{children}</AdminUserContext>
  )
}

export function AdminUserProvider({ children }: { children: React.ReactNode }) {
  return hasClerkKey() ? (
    <ClerkUserProvider>{children}</ClerkUserProvider>
  ) : (
    <LocalUserProvider>{children}</LocalUserProvider>
  )
}

export const useAdminUser = () => useContext(AdminUserContext)
