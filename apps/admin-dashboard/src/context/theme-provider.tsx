'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import {
  ThemeProvider as NextThemesProvider,
  useTheme as useNextTheme,
} from 'next-themes'

type Theme = 'dark' | 'light' | 'system'
type ResolvedTheme = Exclude<Theme, 'system'>

const DEFAULT_THEME: Theme = 'system'
const THEME_STORAGE_KEY = 'gatekit-theme'

type ThemeProviderProps = {
  children: ReactNode
  defaultTheme?: Theme
  storageKey?: string
}

type ThemeProviderState = {
  defaultTheme: Theme
  resolvedTheme: ResolvedTheme
  theme: Theme
  setTheme: (theme: Theme) => void
  resetTheme: () => void
}

type ThemeExtState = Pick<ThemeProviderState, 'defaultTheme' | 'resetTheme'>

const ThemeExtContext = createContext<ThemeExtState | null>(null)

export function ThemeProvider({
  children,
  defaultTheme = DEFAULT_THEME,
  storageKey = THEME_STORAGE_KEY,
}: ThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute='class'
      defaultTheme={defaultTheme}
      storageKey={storageKey}
      enableColorScheme
      disableTransitionOnChange
    >
      <ThemeExtender defaultTheme={defaultTheme}>{children}</ThemeExtender>
    </NextThemesProvider>
  )
}

function ThemeExtender({
  children,
  defaultTheme,
}: {
  children: ReactNode
  defaultTheme: Theme
}) {
  const { setTheme } = useNextTheme()
  const value = useMemo<ThemeExtState>(
    () => ({
      defaultTheme,
      resetTheme: () => setTheme(defaultTheme),
    }),
    [defaultTheme, setTheme]
  )
  return <ThemeExtContext value={value}>{children}</ThemeExtContext>
}

export function useTheme(): ThemeProviderState {
  const next = useNextTheme()
  const ext = useContext(ThemeExtContext)
  if (!ext) throw new Error('useTheme must be used within a ThemeProvider')

  const theme = (next.theme ?? ext.defaultTheme) as Theme
  const resolvedTheme = (next.resolvedTheme ?? 'light') as ResolvedTheme

  return {
    defaultTheme: ext.defaultTheme,
    resolvedTheme,
    theme,
    setTheme: next.setTheme as (theme: Theme) => void,
    resetTheme: ext.resetTheme,
  }
}
