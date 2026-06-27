'use client'

import Link from 'next/link'
import { Ticket } from 'lucide-react'
import {
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'

export function AppTitle() {
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className='flex items-center gap-2 px-2 py-2'>
          <Link
            href='/dashboard'
            onClick={() => setOpenMobile(false)}
            className='flex min-w-0 flex-1 items-center gap-3 rounded-md text-start text-sm leading-tight'
          >
            <span className='flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground'>
              <Ticket aria-hidden='true' className='size-4' />
            </span>
            <span className='grid min-w-0 flex-1'>
              <span className='truncate font-bold'>GateKit</span>
              <span className='truncate text-xs'>Admin</span>
            </span>
          </Link>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
