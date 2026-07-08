import { PermissionGuard } from '@/components/permission-guard';
import { EventMessagesView } from '@/features/events/event-messages-view';
import { isTemplateKey } from '@tixkit/domain';

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>;
  searchParams?: Promise<{ tab?: string | string[]; templateKey?: string | string[] }>;
}) {
  const { eventId } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const tabParam = Array.isArray(resolvedSearchParams?.tab)
    ? resolvedSearchParams?.tab[0]
    : resolvedSearchParams?.tab;
  const templateKeyParam = Array.isArray(resolvedSearchParams?.templateKey)
    ? resolvedSearchParams?.templateKey[0]
    : resolvedSearchParams?.templateKey;
  const initialTab = tabParam === 'lifecycle' ? 'lifecycle' : 'campaigns';
  const initialLifecycleTemplateKey =
    templateKeyParam && isTemplateKey(templateKeyParam) ? templateKeyParam : undefined;
  return (
    <PermissionGuard required="messages.write">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Messages</h1>
            <p className="text-sm text-muted-foreground">
              Send campaigns to attendees of this event
            </p>
          </div>
        </div>
        <EventMessagesView
          eventId={eventId}
          initialLifecycleTemplateKey={initialLifecycleTemplateKey}
          initialTab={initialTab}
        />
      </div>
    </PermissionGuard>
  );
}
