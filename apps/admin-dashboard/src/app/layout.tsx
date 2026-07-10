import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { ClerkProvider } from '@clerk/nextjs';
import { ThemeProvider } from '@/context/theme-provider';
import { DirectionProvider } from '@/context/direction-provider';
import { AdminUserProvider } from '@/context/admin-user-provider';
import { QueryProvider } from '@/context/query-provider';
import { Toaster } from '@/components/ui/sonner';
import { clerkPublishableKey, hasClerkKey } from '@/lib/auth';
import './globals.css';

export const metadata = {
  title: {
    default: 'Tixkit Admin Dashboard',
    template: '%s | Tixkit Admin',
  },
  description: 'Event ticketing and management platform',
};

const refineInjectorSrc =
  process.env.NODE_ENV === 'production' ? null : 'http://localhost:7331/inject.js';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const dir = cookieStore.get('dir')?.value === 'rtl' ? 'rtl' : 'ltr';

  const content = (
    <ThemeProvider>
      <DirectionProvider>
        <QueryProvider>
          <AdminUserProvider>
            {children}
            <Toaster />
          </AdminUserProvider>
        </QueryProvider>
      </DirectionProvider>
    </ThemeProvider>
  );

  return (
    <html lang="en" dir={dir} suppressHydrationWarning>
      <body>
        {hasClerkKey() ? (
          <ClerkProvider publishableKey={clerkPublishableKey()}>{content}</ClerkProvider>
        ) : (
          content
        )}
        {refineInjectorSrc ? (
          <script id="transitions-refine-injector" type="module" src={refineInjectorSrc} />
        ) : null}
      </body>
    </html>
  );
}
