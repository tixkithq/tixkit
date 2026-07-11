import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DocsHeader } from '@/components/docs-header';
import { DocsNavigation } from '@/components/docs-navigation';
import { docsSiteConfig } from '@/lib/site';
import './globals.css';

const config = docsSiteConfig();

export const metadata: Metadata = {
  metadataBase: new URL(config.siteUrl),
  title: { default: 'Tixkit Documentation', template: '%s | Tixkit Documentation' },
  description: 'Operate, integrate, self-host, and contribute to Tixkit.',
  openGraph: {
    title: 'Tixkit Documentation',
    description: 'Operate, integrate, self-host, and contribute to Tixkit.',
    type: 'website',
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <DocsHeader repositoryUrl={config.repositoryUrl} version={config.version} />
        <div className="site-layout">
          <aside className="desktop-sidebar" aria-label="Documentation sidebar">
            <nav aria-label="Documentation">
              <DocsNavigation />
            </nav>
          </aside>
          <main id="main-content" tabIndex={-1}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
