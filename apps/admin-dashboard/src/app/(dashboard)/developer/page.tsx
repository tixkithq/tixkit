import { DeveloperOverview } from '@/features/developer/developer-overview'
import { PermissionGuard } from '@/components/permission-guard'

export default function Page() {
  return (
    <PermissionGuard required='developers.write'>
      <DeveloperOverview />
    </PermissionGuard>
  )
}
