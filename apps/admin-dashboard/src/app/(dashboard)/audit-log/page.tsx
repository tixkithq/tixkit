import { ScrollText } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'

export default function Page() {
  return (
    <div className='space-y-6'>
      <div className='mb-2 flex flex-wrap items-center justify-between gap-2 space-y-2'>
        <div className='space-y-1'>
          <h1 className='text-2xl font-bold tracking-tight'>Audit Log</h1>
          <p className='text-sm text-muted-foreground'>Security-critical action history</p>
        </div>
      </div>
      <EmptyState
        icon={ScrollText}
        title='No audit events yet'
        description='Dangerous and administrative actions will be recorded here for review.'
      />
    </div>
  )
}
