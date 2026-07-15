'use client';

import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, Rocket } from 'lucide-react';
import type { Permission } from '@tixkit/domain';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { routes } from '@/lib/routes';

type PublishedAction = {
  id: string;
  title: string;
  description: string;
  href: string;
  external?: boolean;
};

export type PublishedEventSignalState = 'checking' | 'incomplete' | 'ready';

export function PublishedEventNextActions({
  eventId,
  publicUrl,
  lowInventoryCount,
  checkInNeedsAttention,
  messagingFailureCount,
  signalState,
  can,
  onCopyPublicUrl,
  onRetrySignals,
}: {
  eventId: string;
  publicUrl: string;
  lowInventoryCount: number;
  checkInNeedsAttention: boolean;
  messagingFailureCount: number;
  signalState: PublishedEventSignalState;
  can: (permission: Permission) => boolean;
  onCopyPublicUrl: () => void | Promise<void>;
  onRetrySignals: () => void | Promise<void>;
}) {
  const titleId = React.useId();
  const publicUrlId = React.useId();
  const actions: PublishedAction[] = [];
  if (lowInventoryCount > 0 && can('tickets.write')) {
    actions.push({
      id: 'inventory',
      title: 'Review inventory risk',
      description: `${lowInventoryCount} ticket type${lowInventoryCount === 1 ? '' : 's'} may need more inventory or a sales-window change.`,
      href: routes.eventTickets(eventId),
    });
  }
  if (checkInNeedsAttention && can('checkins.write')) {
    actions.push({
      id: 'check-in',
      title: 'Prepare check-in',
      description: 'Finish the door setup before staff begin scanning tickets.',
      href: routes.eventCheckIn(eventId),
    });
  }
  if (messagingFailureCount > 0 && can('messages.write')) {
    actions.push({
      id: 'messages',
      title: 'Review message outcomes',
      description: `${messagingFailureCount} failed delivery outcome${messagingFailureCount === 1 ? '' : 's'} need review.`,
      href: routes.eventMessages(eventId),
    });
  }
  actions.push({
    id: 'share',
    title: 'Open and share the live page',
    description: 'Verify the buyer-facing page, then share its canonical public URL.',
    href: publicUrl,
    external: true,
  });
  if (can('reports.read')) {
    actions.push({
      id: 'reports',
      title: 'Monitor sales',
      description: 'Track orders, revenue, inventory movement, and export health.',
      href: routes.eventReports(eventId),
    });
  }
  if (can('events.write')) {
    actions.push({
      id: 'test-checkout',
      title: 'Verify another checkout',
      description: 'Run the authenticated buyer preview after material ticket or checkout changes.',
      href: routes.eventPreview(eventId),
    });
  }

  return (
    <section aria-labelledby={titleId} aria-busy={signalState === 'checking'}>
      <Card className="border-emerald-300/70 bg-emerald-50/40 dark:bg-emerald-950/10">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle>
              <h2 id={titleId} className="flex items-center gap-2">
                <Rocket className="size-5 text-emerald-700" aria-hidden="true" />
                Your event is live
              </h2>
            </CardTitle>
            <p className="text-sm text-foreground/80">
              Inventory, messaging, and check-in issues are listed first. Choose the next useful
              action for your role.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onCopyPublicUrl}>
            Copy public link
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {signalState === 'checking' ? (
            <output className="block rounded-md border border-blue-300 bg-blue-50 p-3 text-sm text-blue-950 dark:bg-blue-950/20 dark:text-blue-100">
              Checking inventory, messaging, and launch health. Action priority may change.
            </output>
          ) : null}
          {signalState === 'incomplete' ? (
            <div
              role="alert"
              className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  Health checks are incomplete. These actions remain available, but incident
                  priority may change after retrying the unavailable checks.
                </span>
                <Button type="button" variant="outline" size="sm" onClick={onRetrySignals}>
                  Retry health checks
                </Button>
              </div>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <label htmlFor={publicUrlId} className="text-sm font-medium">
              Public event URL
            </label>
            <input
              id={publicUrlId}
              type="url"
              readOnly
              value={publicUrl}
              onFocus={(event) => event.currentTarget.select()}
              className="h-9 w-full rounded-md border bg-background px-3 font-mono text-sm"
            />
          </div>
          <ol className="grid gap-3 sm:grid-cols-2" aria-labelledby={titleId}>
            {actions.slice(0, 4).map((action, index) => (
              <li key={action.id} className="rounded-lg border bg-background p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {index === 0 && signalState === 'ready'
                    ? 'Recommended next'
                    : `Option ${index + 1}`}
                </p>
                <h3 className="mt-1 font-semibold">{action.title}</h3>
                <p className="mt-1 text-sm text-foreground/80">{action.description}</p>
                {action.external ? (
                  <a
                    className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                    href={action.href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open public page
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <Link
                    className="mt-3 inline-flex text-sm font-medium text-primary hover:underline"
                    href={action.href}
                  >
                    Open {action.title.toLowerCase()}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </section>
  );
}
