'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ReactNode } from 'react';

type Theme = 'dark' | 'light' | 'system';

export function ThemeProvider({ children, nonce }: { children: ReactNode; nonce?: string }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      storageKey="tixkit-checkout-theme"
      enableColorScheme
      nonce={nonce}
    >
      {children}
    </NextThemesProvider>
  );
}

export type { Theme };
