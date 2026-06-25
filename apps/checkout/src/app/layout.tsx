import type { ReactNode } from 'react'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

export const metadata = {
  title: {
    default: 'GateKit Checkout',
    template: '%s | GateKit Checkout',
  },
  description: 'Secure event ticket checkout',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  // Default to 'ltr'. A future brand/locale resolver can override this
  // by passing a `dir` prop or reading brand configuration.
  return (
    <html lang='en' dir='ltr' suppressHydrationWarning>
      <body>
        <ThemeProvider>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
