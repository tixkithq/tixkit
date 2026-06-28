import { MessagesView } from '@/features/messages/messages-view';

export default function Page() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Messages</h1>
          <p className="text-sm text-muted-foreground">Send email and SMS campaigns to attendees</p>
        </div>
      </div>
      <MessagesView />
    </div>
  );
}
