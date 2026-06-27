import { type TixkitPermission, type NavBadgeTone } from '@/lib/permissions'

type SidebarUser = {
  name: string
  email: string
  avatar?: string
}

type BaseNavItem = {
  title: string
  badge?: string
  badgeTone?: NavBadgeTone
  icon?: React.ElementType
  requiredPermission?: TixkitPermission
}

type NavLink = BaseNavItem & {
  url: string
  items?: never
}

type NavCollapsible = BaseNavItem & {
  items: Array<BaseNavItem & { url: string }>
  url?: never
}

type NavItem = NavLink | NavCollapsible

type NavGroup = {
  title: string
  items: NavItem[]
}

type SidebarData = {
  user: SidebarUser
  navGroups: NavGroup[]
}

export type { SidebarData, NavGroup, NavItem, NavCollapsible, NavLink }
