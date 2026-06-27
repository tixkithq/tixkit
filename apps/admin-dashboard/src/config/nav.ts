import {
  BarChart3,
  Code2,
  CreditCard,
  HelpCircle,
  Building2,
  LayoutDashboard,
  MessageSquare,
  Palette,
  QrCode,
  Settings,
  ShoppingCart,
  Ticket,
  Users,
} from 'lucide-react'
import { type SidebarData } from '@/components/layout/types'

export const sidebarData: SidebarData = {
  user: {
    name: 'Local Organizer',
    email: 'organizer@localhost',
  },
  navGroups: [
    {
      title: 'Operate',
      items: [
        { title: 'Overview', url: '/dashboard', icon: LayoutDashboard },
        {
          title: 'Events',
          url: '/events',
          icon: Ticket,
          requiredPermission: 'events.read',
        },
        {
          title: 'Orders',
          url: '/orders',
          icon: ShoppingCart,
          requiredPermission: 'orders.read',
        },
        {
          title: 'Attendees',
          url: '/attendees',
          icon: Users,
          requiredPermission: 'attendees.read',
        },
        {
          title: 'Check-in',
          url: '/check-in',
          icon: QrCode,
          requiredPermission: 'attendees.write',
        },
      ],
    },
    {
      title: 'Grow',
      items: [
        {
          title: 'Messages',
          url: '/messages',
          icon: MessageSquare,
          requiredPermission: 'messages.write',
        },
        {
          title: 'Reports',
          url: '/reports',
          icon: BarChart3,
          requiredPermission: 'reports.read',
        },
      ],
    },
    {
      title: 'Configure',
      items: [
        {
          title: 'Workspace',
          url: '/settings/workspace',
          icon: Building2,
          requiredPermission: 'settings.write',
        },
        {
          title: 'Brand',
          url: '/settings/branding',
          icon: Palette,
          requiredPermission: 'settings.write',
        },
        {
          title: 'Payments',
          url: '/settings/payments',
          icon: CreditCard,
          requiredPermission: 'billing.write',
        },
        {
          title: 'Members',
          url: '/settings/team',
          icon: Users,
          requiredPermission: 'settings.write',
        },
        {
          title: 'Developer',
          icon: Code2,
          requiredPermission: 'developers.write',
          items: [
            { title: 'Overview', url: '/developer' },
            { title: 'API Keys', url: '/developer/api-keys' },
            { title: 'Webhooks', url: '/developer/webhooks' },
          ],
        },
        {
          title: 'Settings',
          icon: Settings,
          requiredPermission: 'settings.write',
          items: [
            { title: 'Profile', url: '/settings/profile' },
            { title: 'Appearance', url: '/settings/appearance' },
            { title: 'Billing', url: '/settings/billing', requiredPermission: 'billing.write' },
          ],
        },
      ],
    },
    {
      title: 'Support',
      items: [
        { title: 'Help', url: '/help', icon: HelpCircle },
      ],
    },
  ],
}
