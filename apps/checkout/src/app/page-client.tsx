'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { TicketIcon } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';

export default function RootPageClient() {
  const router = useRouter();
  const params = useSearchParams();

  const eventId = params.get('eventId');
  const sessionId = params.get('sessionId');

  useEffect(() => {
    if (eventId) {
      router.replace(`/e/${encodeURIComponent(eventId)}`);
    } else if (sessionId) {
      // Redirect to checkout resume with only sessionId (no token in URL).
      // The checkout page resolves the token from sessionStorage.
      router.replace(`/checkout?sessionId=${encodeURIComponent(sessionId)}`);
    }
  }, [eventId, sessionId, router]);

  if (eventId || sessionId) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-md">
        <EmptyState
          icon={TicketIcon}
          title="No event selected"
          description="Open the ticket link from your event invite or organizer page to start checkout."
        />
      </div>
    </div>
  );
}
