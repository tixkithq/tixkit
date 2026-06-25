import { ApiKeysView } from '@/features/developer/api-keys-view'
import { PermissionGuard } from '@/components/permission-guard'

export default function Page() {
  return (
    <PermissionGuard required='developers.write'>
      <div className='space-y-6'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div className='space-y-1'>
            <h1 className='text-2xl font-bold tracking-tight'>API Keys</h1>
            <p className='text-sm text-muted-foreground'>
              Manage scoped keys for API access
            </p>
          </div>
        </div>
        <ApiKeysView />
      </div>
    </PermissionGuard>
  )
}
