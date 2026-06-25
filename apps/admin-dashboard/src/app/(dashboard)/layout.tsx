import type { ReactNode } from 'react'
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import { ConfigDrawer } from '@/components/config-drawer'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { NavigationProgress } from '@/components/navigation-progress'
import { hasClerkKey } from '@/lib/auth'

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode
}) {
  if (hasClerkKey()) {
    const { userId, getToken } = await auth()
    if (!userId) redirect('/sign-in')

    const token = await getToken()
    const { adminApi } = await import('@/lib/api')
    const principalRes = await adminApi.getPrincipal(token ?? undefined)

    if (!principalRes.ok) {
      console.error('Failed to fetch GateKit principal:', principalRes.error)
      redirect('/sign-in?error=unauthorized')
    }
  }

  return (
    <AuthenticatedLayout>
      <NavigationProgress />
      <Header fixed>
        <Search />
        <ThemeSwitch />
        <ConfigDrawer />
        <ProfileDropdown />
      </Header>
      <Main id='content'>{children}</Main>
    </AuthenticatedLayout>
  )
}
