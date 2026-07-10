import { Suspense } from 'react';
import { CheckInConsole } from '@/features/kiosk/check-in-console';
import { Skeleton } from '@/components/ui/skeleton';

type SearchParams =
  | Promise<Record<string, string | string[] | undefined>>
  | Record<string, string | string[] | undefined>;
type Params = Promise<{ eventId: string }> | { eventId: string };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function KioskEventPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams?: SearchParams;
}) {
  const resolvedParams = await params;
  const resolvedSearch = (await searchParams) ?? {};
  const listId = first(resolvedSearch.listId);
  const tabValue = first(resolvedSearch.tab);
  const tab =
    tabValue === 'scan' || tabValue === 'activity' || tabValue === 'sales' ? tabValue : undefined;

  return (
    <Suspense
      fallback={
        <div className="space-y-4 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      }
    >
      <CheckInConsole
        mode="kiosk"
        initialEventId={resolvedParams.eventId}
        initialListId={listId}
        initialTab={tab}
      />
    </Suspense>
  );
}
