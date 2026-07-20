import type { ReactNode } from 'react';
import { cookies, headers } from 'next/headers';
import { connection } from 'next/server';
import { ClerkProvider } from '@clerk/nextjs';
import { ThemeProvider } from '@/context/theme-provider';
import { DirectionProvider } from '@/context/direction-provider';
import { AdminUserProvider } from '@/context/admin-user-provider';
import { QueryProvider } from '@/context/query-provider';
import { Toaster } from '@/components/ui/sonner';
import { runtimeConfigDataAttributes } from '@/lib/runtime-config-contract';
import { parseAdminRuntimeConfig } from '@/lib/runtime-config-server';
import { RuntimeConfigProvider } from '@/context/runtime-config-provider';
import './globals.css';

export const metadata = {
  title: {
    default: 'Tixkit Admin Dashboard',
    template: '%s | Tixkit Admin',
  },
  description: 'Event ticketing and management platform',
};

export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const runtimeConfig = parseAdminRuntimeConfig();
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const cookieStore = await cookies();
  const dir = cookieStore.get('dir')?.value === 'rtl' ? 'rtl' : 'ltr';

  const content = (
    <RuntimeConfigProvider config={runtimeConfig}>
      <ThemeProvider nonce={nonce}>
        <DirectionProvider>
          <QueryProvider>
            <AdminUserProvider>
              {children}
              <Toaster />
            </AdminUserProvider>
          </QueryProvider>
        </DirectionProvider>
      </ThemeProvider>
    </RuntimeConfigProvider>
  );

  return (
    <html
      lang="en"
      dir={dir}
      suppressHydrationWarning
      {...runtimeConfigDataAttributes(runtimeConfig)}
    >
      <body>
        <script
          id="zod-jitless-config"
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html:
              'globalThis.__zod_globalConfig={...(globalThis.__zod_globalConfig||{}),jitless:true}',
          }}
        />
        {runtimeConfig.authProvider === 'clerk' && runtimeConfig.clerkPublishableKey ? (
          <ClerkProvider dynamic publishableKey={runtimeConfig.clerkPublishableKey}>
            {content}
          </ClerkProvider>
        ) : (
          content
        )}
        {runtimeConfig.deploymentProfile === 'development' ? (
          <script
            id="transitions-refine-injector"
            type="module"
            src="http://localhost:7331/inject.js"
            nonce={nonce}
          />
        ) : null}
      </body>
    </html>
  );
}
