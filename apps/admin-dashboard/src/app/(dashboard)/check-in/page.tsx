import { Suspense } from 'react';
import { PermissionGuard } from '@/components/permission-guard';
import { CheckInConsole } from '@/features/kiosk/check-in-console';
import { Skeleton } from '@/components/ui/skeleton';

type SearchParams =
  | Promise<Record<string, string | string[] | undefined>>
  | Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function Page({ searchParams }: { searchParams?: SearchParams }) {
  const params = (await searchParams) ?? {};
  const eventId = first(params.eventId);
  const listId = first(params.listId);
  const tabValue = first(params.tab);
  const tab =
    tabValue === 'scan' || tabValue === 'activity' || tabValue === 'sales' ? tabValue : undefined;

  return (
    <PermissionGuard
      anyOf={['checkins.write', 'checkins.read', 'box_office.write', 'orders.write']}
    >
      <Suspense
        fallback={
          <div className="space-y-4">
            <Skeleton className="h-10 w-full max-w-xs" />
            <Skeleton className="h-40 w-full" />
          </div>
        }
      >
        <CheckInConsole
          mode="embedded"
          initialEventId={eventId}
          initialListId={listId}
          initialTab={tab}
        />
      </Suspense>
    </PermissionGuard>
  );
}
