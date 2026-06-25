import { type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

type EmptyStateProps = {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-10 text-center',
        className,
      )}
    >
      {Icon ? (
        <div className='flex size-10 items-center justify-center rounded-full bg-muted'>
          <Icon className='size-5 text-muted-foreground' />
        </div>
      ) : null}
      <div className='space-y-1'>
        <p className='font-medium'>{title}</p>
        {description ? (
          <p className='text-sm text-muted-foreground'>{description}</p>
        ) : null}
      </div>
      {action ? <div className='mt-2'>{action}</div> : null}
    </div>
  )
}
