'use client'

import {
  Sun,
  Moon,
  Laptop,
  ArrowLeftRight,
  ArrowRightLeft,
  PanelLeft,
  PanelRight,
  Square,
  Maximize2,
  Minimize2,
  RotateCcw,
} from 'lucide-react'
import { useTheme } from '@/context/theme-provider'
import { useDirection } from '@/context/direction-provider'
import { type Collapsible, type SidebarVariant, useLayout } from '@/context/layout-provider'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function AppearanceSettings() {
  const { theme, setTheme, defaultTheme, resetTheme } = useTheme()
  const { dir, setDir, defaultDir, resetDir } = useDirection()
  const {
    variant,
    setVariant,
    defaultVariant,
    collapsible,
    setCollapsible,
    defaultCollapsible,
    resetLayout,
  } = useLayout()

  return (
    <div className='space-y-6'>
      <Card>
        <CardHeader>
          <CardTitle>Theme</CardTitle>
          <CardDescription>
            Choose between light, dark, or system theme.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='grid grid-cols-3 gap-3'>
            {[
              { value: 'light' as const, label: 'Light', icon: Sun },
              { value: 'dark' as const, label: 'Dark', icon: Moon },
              { value: 'system' as const, label: 'System', icon: Laptop },
            ].map((opt) => (
              <button
                key={opt.value}
                type='button'
                onClick={() => setTheme(opt.value)}
                className={cn(
                  'flex flex-col items-center gap-2 rounded-lg border p-4 transition-colors hover:bg-accent/50',
                  theme === opt.value && 'border-primary bg-accent'
                )}
              >
                <opt.icon className='size-5' />
                <span className='text-sm font-medium'>{opt.label}</span>
              </button>
            ))}
          </div>
          {theme !== defaultTheme && (
            <Button
              variant='ghost'
              size='sm'
              onClick={resetTheme}
            >
              <RotateCcw className='size-4' />
              Reset to default
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Direction</CardTitle>
          <CardDescription>
            Choose between left-to-right or right-to-left text direction.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='grid grid-cols-2 gap-3'>
            {[
              { value: 'ltr' as const, label: 'Left to Right', icon: ArrowLeftRight },
              { value: 'rtl' as const, label: 'Right to Left', icon: ArrowRightLeft },
            ].map((opt) => (
              <button
                key={opt.value}
                type='button'
                onClick={() => setDir(opt.value)}
                className={cn(
                  'flex flex-col items-center gap-2 rounded-lg border p-4 transition-colors hover:bg-accent/50',
                  dir === opt.value && 'border-primary bg-accent'
                )}
              >
                <opt.icon className='size-5' />
                <span className='text-sm font-medium'>{opt.label}</span>
              </button>
            ))}
          </div>
          {dir !== defaultDir && (
            <Button variant='ghost' size='sm' onClick={resetDir}>
              <RotateCcw className='size-4' />
              Reset to default
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sidebar Variant</CardTitle>
          <CardDescription>
            Choose how the sidebar interacts with the main content area.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='grid grid-cols-3 gap-3'>
            {[
              { value: 'inset' as const, label: 'Inset', icon: Square },
              { value: 'sidebar' as const, label: 'Sidebar', icon: PanelLeft },
              { value: 'floating' as const, label: 'Floating', icon: PanelRight },
            ].map((opt) => (
              <button
                key={opt.value}
                type='button'
                onClick={() => setVariant(opt.value as SidebarVariant)}
                className={cn(
                  'flex flex-col items-center gap-2 rounded-lg border p-4 transition-colors hover:bg-accent/50',
                  variant === opt.value && 'border-primary bg-accent'
                )}
              >
                <opt.icon className='size-5' />
                <span className='text-sm font-medium'>{opt.label}</span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sidebar Collapse</CardTitle>
          <CardDescription>
            Choose how the sidebar collapses on desktop.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='grid grid-cols-3 gap-3'>
            {[
              { value: 'icon' as const, label: 'Icon Only', icon: Minimize2 },
              { value: 'offcanvas' as const, label: 'Offcanvas', icon: Maximize2 },
              { value: 'none' as const, label: 'No Collapse', icon: PanelLeft },
            ].map((opt) => (
              <button
                key={opt.value}
                type='button'
                onClick={() => setCollapsible(opt.value as Collapsible)}
                className={cn(
                  'flex flex-col items-center gap-2 rounded-lg border p-4 transition-colors hover:bg-accent/50',
                  collapsible === opt.value && 'border-primary bg-accent'
                )}
              >
                <opt.icon className='size-5' />
                <span className='text-sm font-medium'>{opt.label}</span>
              </button>
            ))}
          </div>
          {(variant !== defaultVariant || collapsible !== defaultCollapsible) && (
            <Button variant='ghost' size='sm' onClick={resetLayout}>
              <RotateCcw className='size-4' />
              Reset layout to default
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
