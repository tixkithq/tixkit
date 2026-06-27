'use client'

import React from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowRight,
  Laptop,
  Moon,
  Sun,
  Ticket,
  ShoppingCart,
  Users,
  QrCode,
  BarChart3,
  KeyRound,
  Webhook,
  Building2,
  Palette,
  CreditCard,
  Wallet,
  User,
} from 'lucide-react'
import { useSearch } from '@/context/search-provider'
import { useTheme } from '@/context/theme-provider'
import { usePermissions } from '@/context/permission-provider'
import { type TixkitPermission } from '@/lib/permissions'
import { routes } from '@/lib/routes'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { sidebarData } from '@/config/nav'
import { ScrollArea } from './ui/scroll-area'

type CommandMenuItem = {
  id: string
  title: string
  subtitle?: string
  href?: string
  icon?: React.ElementType
  keywords?: string[]
  action?: () => void
  requiredPermission?: TixkitPermission
}

export function CommandMenu() {
  const router = useRouter()
  const { setTheme } = useTheme()
  const { open, setOpen } = useSearch()
  const { can } = usePermissions()

  const runCommand = React.useCallback(
    (command: () => unknown) => {
      setOpen(false)
      command()
    },
    [setOpen]
  )

  // Build navigation items from sidebar data, filtered by permission
  const navItems: CommandMenuItem[] = []
  for (const group of sidebarData.navGroups) {
    for (const item of group.items) {
      if (item.url) {
        if (can(item.requiredPermission)) {
          navItems.push({
            id: item.url,
            title: item.title,
            href: item.url,
            icon: item.icon,
            requiredPermission: item.requiredPermission,
          })
        }
      } else if (item.items) {
        for (const sub of item.items) {
          if (can(sub.requiredPermission ?? item.requiredPermission)) {
            navItems.push({
              id: sub.url,
              title: `${item.title} ${sub.title}`,
              subtitle: item.title,
              href: sub.url,
              icon: item.icon,
              requiredPermission: sub.requiredPermission ?? item.requiredPermission,
            })
          }
        }
      }
    }
  }

  const eventActions: CommandMenuItem[] = [
    {
      id: 'create-event',
      title: 'Create Event',
      subtitle: 'Create a new ticketed event',
      href: routes.events,
      icon: Ticket,
      keywords: ['new', 'event', 'create'],
      requiredPermission: 'events.write',
    },
    {
      id: 'view-events',
      title: 'View All Events',
      href: routes.events,
      icon: Ticket,
      keywords: ['events', 'list'],
      requiredPermission: 'events.read',
    },
  ]

  const reportingActions: CommandMenuItem[] = [
    {
      id: 'view-reports',
      title: 'View Reports',
      href: routes.reports,
      icon: BarChart3,
      keywords: ['reports', 'analytics', 'sales'],
      requiredPermission: 'reports.read',
    },
    {
      id: 'view-orders',
      title: 'View Orders',
      href: routes.orders,
      icon: ShoppingCart,
      keywords: ['orders', 'payments'],
      requiredPermission: 'orders.read',
    },
    {
      id: 'view-attendees',
      title: 'View Attendees',
      href: routes.attendees,
      icon: Users,
      keywords: ['attendees', 'guests'],
      requiredPermission: 'attendees.read',
    },
  ]

  const developerActions: CommandMenuItem[] = [
    {
      id: 'api-keys',
      title: 'Manage API Keys',
      href: routes.developerApiKeys,
      icon: KeyRound,
      keywords: ['api', 'keys', 'developer'],
      requiredPermission: 'developers.write',
    },
    {
      id: 'webhooks',
      title: 'Manage Webhooks',
      href: routes.developerWebhooks,
      icon: Webhook,
      keywords: ['webhooks', 'endpoints', 'developer'],
      requiredPermission: 'developers.write',
    },
  ]

  const settingsItems: CommandMenuItem[] = [
    { id: 'settings-profile', title: 'Profile Settings', href: routes.settingsProfile, icon: User, keywords: ['profile', 'account'] },
    { id: 'settings-workspace', title: 'Workspace Settings', href: routes.settingsWorkspace, icon: Building2, keywords: ['workspace', 'organization', 'tenant'] },
    { id: 'settings-appearance', title: 'Appearance Settings', href: routes.settingsAppearance, icon: Palette, keywords: ['theme', 'appearance', 'dark', 'light'] },
    { id: 'settings-members', title: 'Members Settings', href: routes.settingsTeam, icon: Users, keywords: ['members', 'users', 'team', 'roles'], requiredPermission: 'settings.write' },
    { id: 'settings-billing', title: 'Billing Settings', href: routes.settingsBilling, icon: CreditCard, keywords: ['billing', 'plan', 'invoices'], requiredPermission: 'billing.write' },
    { id: 'settings-payments', title: 'Payment Settings', href: routes.settingsPayments, icon: Wallet, keywords: ['payments', 'stripe', 'connect'], requiredPermission: 'billing.write' },
    { id: 'settings-branding', title: 'Branding Settings', href: routes.settingsBranding, icon: Palette, keywords: ['branding', 'logo', 'colors', 'domains'], requiredPermission: 'settings.write' },
  ]

  const checkInAction: CommandMenuItem = {
    id: 'check-in',
    title: 'Open Check-in Scanner',
    href: routes.checkIn,
    icon: QrCode,
    keywords: ['check-in', 'scan', 'qr'],
    requiredPermission: 'attendees.write',
  }

  const renderItem = (item: CommandMenuItem) => {
    if (!can(item.requiredPermission)) return null
    return (
      <CommandItem
        key={item.id}
        value={`${item.title} ${item.keywords?.join(' ') ?? ''}`}
        onSelect={() => {
          if (item.action) {
            runCommand(item.action)
          } else if (item.href) {
            runCommand(() => router.push(item.href!))
          }
        }}
      >
        <div className='flex size-4 items-center justify-center'>
          {item.icon ? (
            <item.icon className='size-4 text-muted-foreground' />
          ) : (
            <ArrowRight className='size-2 text-muted-foreground/80' />
          )}
        </div>
        <span>{item.title}</span>
        {item.subtitle && (
          <span className='text-xs text-muted-foreground'>
            {item.subtitle}
          </span>
        )}
      </CommandItem>
    )
  }

  return (
    <CommandDialog modal open={open} onOpenChange={setOpen}>
      <CommandInput placeholder='Type a command or search...' />
      <CommandList>
        <ScrollArea type='hover' className='h-72 pe-1'>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading='Navigation'>
            {navItems.map(renderItem)}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading='Event Actions'>
            {eventActions.map(renderItem)}
            {renderItem(checkInAction)}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading='Reporting'>
            {reportingActions.map(renderItem)}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading='Developer'>
            {developerActions.map(renderItem)}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading='Settings'>
            {settingsItems.map(renderItem)}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading='Theme'>
            <CommandItem onSelect={() => runCommand(() => setTheme('light'))}>
              <Sun /> <span>Light</span>
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => setTheme('dark'))}>
              <Moon className='scale-90' />
              <span>Dark</span>
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => setTheme('system'))}>
              <Laptop />
              <span>System</span>
            </CommandItem>
          </CommandGroup>
        </ScrollArea>
      </CommandList>
    </CommandDialog>
  )
}
