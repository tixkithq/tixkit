import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import { ClerkProvider } from '@clerk/nextjs'
import { ThemeProvider } from '@/context/theme-provider'
import { DirectionProvider } from '@/context/direction-provider'
import { AdminUserProvider } from '@/context/admin-user-provider'
import { Toaster } from '@/components/ui/sonner'
import { clerkPublishableKey, hasClerkKey } from '@/lib/auth'
import './globals.css'

export const metadata = {
  title: {
    default: 'GateKit Admin Dashboard',
    template: '%s | GateKit Admin',
  },
  description: 'Event ticketing and management platform',
}

export default async function RootLayout({
  children,
}: {
  children: ReactNode
}) {
  const cookieStore = await cookies()
  const dir = cookieStore.get('dir')?.value === 'rtl' ? 'rtl' : 'ltr'

  const content = (
    <ThemeProvider>
      <DirectionProvider>
        <AdminUserProvider>
          {children}
          <Toaster />
        </AdminUserProvider>
      </DirectionProvider>
    </ThemeProvider>
  )

  return (
    <html lang='en' dir={dir} suppressHydrationWarning>
      <body>
        {hasClerkKey() ? (
          <ClerkProvider publishableKey={clerkPublishableKey()}>
            {content}
          </ClerkProvider>
        ) : (
          content
        )}
      </body>
    </html>
  )
}
