import { PermissionGuard } from '@/components/permission-guard';
import { ReportsView } from '@/features/reports/reports-view';

export default function Page() {
  return (
    <PermissionGuard required="reports.read">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
            <p className="text-sm text-muted-foreground">Sales, tax, and attendance analytics</p>
          </div>
        </div>
        <ReportsView />
      </div>
    </PermissionGuard>
  );
}
