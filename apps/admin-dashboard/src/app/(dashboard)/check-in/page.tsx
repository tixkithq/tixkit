import { PermissionGuard } from '@/components/permission-guard';
import { CheckInView } from '@/features/check-in/scan-view';

export default function Page() {
  return (
    <PermissionGuard required="checkins.write">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Check-in</h1>
            <p className="text-sm text-muted-foreground">
              Scan tickets and admit attendees at the door
            </p>
          </div>
        </div>
        <CheckInView />
      </div>
    </PermissionGuard>
  );
}
