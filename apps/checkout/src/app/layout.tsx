import type { ReactNode } from 'react';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
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

export default function RootLayout({ children }: { children: ReactNode }) {
  // Default to 'ltr'. A future brand/locale resolver can override this
  // by passing a `dir` prop or reading brand configuration.
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          {children}
          <Toaster position="bottom-right" />
        </ThemeProvider>
        {refineInjectorSrc ? (
          <script id="transitions-refine-injector" type="module" src={refineInjectorSrc} />
        ) : null}
      </body>
    </html>
  );
}
