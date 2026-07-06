import { EventScopeGuard } from '@/features/events/event-scope-guard';

export default async function EventLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  return <EventScopeGuard eventId={eventId}>{children}</EventScopeGuard>;
}
