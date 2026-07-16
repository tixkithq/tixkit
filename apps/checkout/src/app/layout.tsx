import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { WebVitalsReporter } from '@/components/web-vitals-reporter';
import '@tixkit/content-event-page-react/styles.css';
import './globals.css';

export const metadata = {
  title: {
    default: 'Tixkit Checkout',
    template: '%s | Tixkit Checkout',
  },
  description: 'Secure event ticket checkout',
};

const refineInjectorSrc =
  process.env.NODE_ENV === 'production' || process.env.NEXT_PUBLIC_DISABLE_REACT_DEVTOOLS === '1'
    ? null
    : 'http://localhost:7331/inject.js';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  // Default to 'ltr'. A future brand/locale resolver can override this
  // by passing a `dir` prop or reading brand configuration.
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html:
              'globalThis.__zod_globalConfig={...(globalThis.__zod_globalConfig||{}),jitless:true}',
          }}
        />
        <ThemeProvider nonce={nonce}>
          <WebVitalsReporter />
          {children}
          <Toaster position="bottom-right" />
        </ThemeProvider>
        {refineInjectorSrc ? (
          <script
            id="transitions-refine-injector"
            type="module"
            src={refineInjectorSrc}
            nonce={nonce}
          />
        ) : null}
      </body>
    </html>
  );
}
