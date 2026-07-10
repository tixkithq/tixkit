import { PermissionGuard } from '@/components/permission-guard';
import { MessagesView } from '@/features/messages/messages-view';
import { isTemplateKey } from '@tixkit/domain';

export default async function Page({
  searchParams,
}: {
  searchParams?: Promise<{
    eventId?: string | string[];
    tab?: string | string[];
    templateKey?: string | string[];
  }>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const eventIdParam = Array.isArray(resolvedSearchParams?.eventId)
    ? resolvedSearchParams.eventId[0]
    : resolvedSearchParams?.eventId;
  const tabParam = Array.isArray(resolvedSearchParams?.tab)
    ? resolvedSearchParams.tab[0]
    : resolvedSearchParams?.tab;
  const templateKeyParam = Array.isArray(resolvedSearchParams?.templateKey)
    ? resolvedSearchParams.templateKey[0]
    : resolvedSearchParams?.templateKey;
  const initialLifecycleTemplateKey =
    templateKeyParam && isTemplateKey(templateKeyParam) ? templateKeyParam : undefined;

  return (
    <PermissionGuard required="messages.write">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Messages</h1>
            <p className="text-sm text-muted-foreground">
              Send email and SMS campaigns to attendees
            </p>
          </div>
        </div>
        <MessagesView
          initialEventId={eventIdParam}
          initialLifecycleTemplateKey={initialLifecycleTemplateKey}
          initialTab={tabParam === 'lifecycle' ? 'lifecycle' : 'campaigns'}
        />
      </div>
    </PermissionGuard>
  );
}
