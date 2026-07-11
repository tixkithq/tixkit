import { PermissionGuard } from '@/components/permission-guard';
import { MigrationWorkspace } from '@/features/migrations/migration-workspace';

export default function Page() {
  return (
    <PermissionGuard required="migrations.read">
      <MigrationWorkspace />
    </PermissionGuard>
  );
}
