'use client'

import Link from 'next/link'
import { Menu } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type TopNavProps = React.HTMLAttributes<HTMLElement> & {
  links: {
    title: string
    href: string
    isActive: boolean
    disabled?: boolean
  }[]
}

export function TopNav({ className, links, ...props }: TopNavProps) {
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            size='icon'
            variant='outline'
            className={cn('md:size-7 lg:hidden', className)}
          >
            <Menu />
            <span className='sr-only'>Toggle navigation menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side='bottom' align='start'>
          {links.map(({ title, href, isActive, disabled }) =>
            disabled ? (
              <DropdownMenuItem key={`${title}-${href}`} disabled>
                {title}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem key={`${title}-${href}`} asChild>
                <Link
                  href={href}
                  className={!isActive ? 'text-muted-foreground' : ''}
                >
                  {title}
                </Link>
              </DropdownMenuItem>
            )
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <nav
        className={cn(
          'hidden items-center space-x-4 lg:flex lg:space-x-4 xl:space-x-6',
          className
        )}
        {...props}
      >
        {links.map(({ title, href, isActive, disabled }) =>
          disabled ? (
            <span
              key={`${title}-${href}`}
              className='text-sm font-medium text-muted-foreground/60'
              aria-disabled='true'
            >
              {title}
            </span>
          ) : (
            <Link
              key={`${title}-${href}`}
              href={href}
              className={`text-sm font-medium transition-colors hover:text-primary ${isActive ? '' : 'text-muted-foreground'}`}
            >
              {title}
            </Link>
          )
        )}
      </nav>
    </>
  )
}
