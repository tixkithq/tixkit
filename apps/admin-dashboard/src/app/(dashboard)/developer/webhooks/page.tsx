import { WebhooksView } from '@/features/developer/webhooks-view';
import { PermissionGuard } from '@/components/permission-guard';

export default function Page() {
  return (
    <PermissionGuard required="developers.write">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Webhooks</h1>
            <p className="text-sm text-muted-foreground">
              Deliver event notifications to your endpoints
            </p>
          </div>
        </div>
        <WebhooksView />
      </div>
    </PermissionGuard>
  );
}
