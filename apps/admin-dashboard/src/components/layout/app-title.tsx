'use client'

import Link from 'next/link'
import { ChevronLeft, ChevronRight, Ticket } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'

export function AppTitle() {
  const { isMobile, setOpenMobile, state, toggleSidebar } = useSidebar()
  const isCollapsed = state === 'collapsed' && !isMobile
  const ToggleIcon = isCollapsed ? ChevronRight : ChevronLeft

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div
          className={cn(
            'flex items-center gap-2 px-2 py-2',
            isCollapsed && 'justify-center px-1'
          )}
        >
          <Link
            href='/dashboard'
            onClick={() => setOpenMobile(false)}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-3 rounded-md text-start text-sm leading-tight',
              isCollapsed && 'hidden'
            )}
          >
            <span className='flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground'>
              <Ticket aria-hidden='true' className='size-4' />
            </span>
            <span className='grid min-w-0 flex-1'>
              <span className='truncate font-bold'>GateKit</span>
              <span className='truncate text-xs'>Admin</span>
            </span>
          </Link>
          <Button
            type='button'
            variant='ghost'
            size='icon'
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className='size-8 shrink-0'
            onClick={toggleSidebar}
          >
            <ToggleIcon aria-hidden='true' className='size-4' />
          </Button>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
