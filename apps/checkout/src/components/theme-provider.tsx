'use client'

import { ThemeProvider as NextThemesProvider } from 'next-themes'
import type { ReactNode } from 'react'

type Theme = 'dark' | 'light' | 'system'

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute='class'
      defaultTheme='system'
      storageKey='gatekit-checkout-theme'
      enableColorScheme
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  )
}

export type { Theme }
