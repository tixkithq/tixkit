'use client';

import { useEffect, useRef } from 'react';
import { RefreshCwIcon } from 'lucide-react';
import { toast } from 'sonner';
import { publicApi } from '@/lib/api';

type Props = {
  eventId?: string;
};

function showToast(message: string, description: string) {
  toast.info(message, {
    description,
    duration: Infinity,
    action: {
      label: 'Refresh',
      onClick: () => window.location.reload(),
    },
    icon: <RefreshCwIcon className="size-4" />,
  });
}

export function RefreshNotifier({ eventId }: Props) {
  const initialRevision = useRef<string | null | undefined>(undefined);
  const notified = useRef(false);

  useEffect(() => {
    if (!eventId) return;
    notified.current = false;

    let cancelled = false;

    async function captureInitial() {
      try {
        const revision = await publicApi.getEventRevision(eventId!);
        if (!cancelled) initialRevision.current = revision;
      } catch {
        if (!cancelled) initialRevision.current = null;
      }
    }

    captureInitial();

    async function checkRevision() {
      if (cancelled || notified.current || initialRevision.current === undefined) return;
      try {
        const revision = await publicApi.getEventRevision(eventId!);
        if (cancelled || notified.current) return;
        if (revision !== initialRevision.current) {
          notified.current = true;
          showToast('Event details have been updated', 'Refresh to see the latest changes.');
        }
      } catch {
        // Network errors are expected during offline periods; skip silently.
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        checkRevision();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [eventId]);

  return null;
}
