import { PermissionGuard } from '@/components/permission-guard';
import { EventProductsView } from '@/features/events/event-products-view';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return (
    <PermissionGuard required="tickets.write">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Products</h1>
            <p className="text-sm text-muted-foreground">
              Manage product add-ons, categories, and per-order limits.
            </p>
          </div>
        </div>
        <EventProductsView eventId={eventId} />
      </div>
    </PermissionGuard>
  );
}
