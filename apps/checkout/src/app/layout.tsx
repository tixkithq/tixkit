import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { connection } from 'next/server';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { WebVitalsReporter } from '@/components/web-vitals-reporter';
import { RuntimeConfigProvider } from '@/context/runtime-config-provider';
import { runtimeConfigDataAttributes } from '@/lib/runtime-config-contract';
import { parseCheckoutRuntimeConfig } from '@/lib/runtime-config-server';
import '@tixkit/content-event-page-react/styles.css';
import './globals.css';

export const metadata = {
  title: {
    default: 'Tixkit Checkout',
    template: '%s | Tixkit Checkout',
  },
  description: 'Secure event ticket checkout',
};

export const dynamic = 'force-dynamic';

function runtimeStyleNonceBootstrap(nonce: string | undefined): string {
  if (!nonce) return '';
  return `(()=>{const nonce=document.currentScript?.nonce;if(!nonce)return;const createElement=Document.prototype.createElement;Document.prototype.createElement=function(tagName,options){const element=createElement.call(this,tagName,options);if(String(tagName).toLowerCase()==='style')element.setAttribute('nonce',nonce);return element;};})();`;
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const runtimeConfig = parseCheckoutRuntimeConfig();
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  // Default to 'ltr'. A future brand/locale resolver can override this
  // by passing a `dir` prop or reading brand configuration.
  return (
    <html
      lang="en"
      dir="ltr"
      suppressHydrationWarning
      {...runtimeConfigDataAttributes(runtimeConfig)}
    >
      <head>
        <script
          id="runtime-style-nonce-bootstrap"
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: runtimeStyleNonceBootstrap(nonce) }}
        />
      </head>
      <body>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html:
              'globalThis.__zod_globalConfig={...(globalThis.__zod_globalConfig||{}),jitless:true}',
          }}
        />
        <RuntimeConfigProvider config={runtimeConfig}>
          <ThemeProvider nonce={nonce}>
            <WebVitalsReporter />
            {children}
            <Toaster position="bottom-right" />
          </ThemeProvider>
        </RuntimeConfigProvider>
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
