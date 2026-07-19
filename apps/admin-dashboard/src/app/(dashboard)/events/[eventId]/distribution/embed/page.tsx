import { PermissionGuard } from '@/components/permission-guard';
import { EmbedStudio } from '@/features/events/embed-studio';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return (
    <PermissionGuard required="events.read">
      <EmbedStudio eventId={eventId} />
    </PermissionGuard>
  );
}
