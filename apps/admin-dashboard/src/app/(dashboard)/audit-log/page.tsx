import { AuditLogView } from '@/features/developer/audit-log-view';
import { PermissionGuard } from '@/components/permission-guard';

export default function Page() {
  return (
    <PermissionGuard required="settings.write">
      <div className="space-y-6">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 space-y-2">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
            <p className="text-sm text-muted-foreground">Security-critical action history</p>
          </div>
        </div>
        <AuditLogView />
      </div>
    </PermissionGuard>
  );
}
