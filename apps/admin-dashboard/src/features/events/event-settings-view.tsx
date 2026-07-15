'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { adminApi } from '@/lib/api';
import { routes } from '@/lib/routes';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { EventForm } from './event-form';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EventMediaSettings } from './event-media-settings';
import { EventFeePolicyCard } from './event-fee-policy-card';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

const sections = [
  ['basics', 'Basics'],
  ['schedule', 'Schedule and venue'],
  ['sales', 'Sales settings'],
  ['media', 'Media'],
  ['marketing-fields', 'SEO and marketing'],
] as const;

export function EventSettingsView({ eventId }: { eventId: string }) {
  const router = useRouter();
  const {
    data: event,
    loading,
    error,
    refetch,
  } = useAdminQuery(['getEvent', eventId], () => adminApi.getEvent(eventId));
  const { data: ticketTypes } = useAdminQuery(['listTicketTypes', eventId], () =>
    adminApi.listTicketTypes(eventId),
  );
  React.useEffect(() => {
    if (!event || window.location.hash) return;
    const section =
      window.localStorage.getItem(`tixkit:event:${eventId}:last-setup-section`) ??
      event.lastSetupSection;
    if (!section) return;
    window.history.replaceState(null, '', `#${section}`);
    document.getElementById(section)?.scrollIntoView();
  }, [event, eventId]);
  if (loading) return <Skeleton className="h-[32rem] w-full" />;
  if (error || !event)
    return (
      <div role="alert" className="space-y-3 rounded-lg border p-6">
        <p>{error?.message ?? 'Event not found.'}</p>
        <div className="flex gap-2">
          <Button onClick={() => void refetch()}>Retry</Button>
          <Button variant="outline" asChild>
            <Link href={routes.eventDetail(eventId)}>Back to launch center</Link>
          </Button>
        </div>
      </div>
    );
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-2">
        <Link className="text-sm text-primary hover:underline" href={routes.eventDetail(eventId)}>
          ← Back to launch center
        </Link>
        <h1 className="text-3xl font-bold">Event settings</h1>
        <p className="text-muted-foreground">
          Advanced configuration autosaves by section and retains an explicit save action.
          Publication status uses audited lifecycle actions only.
        </p>
      </header>
      <nav aria-label="Event settings sections" className="flex gap-2 overflow-x-auto pb-2">
        {sections.map(([id, label]) => (
          <a
            key={id}
            className="whitespace-nowrap rounded-full border px-3 py-1.5 text-sm hover:bg-accent"
            href={`#${id}`}
            onClick={() => {
              window.localStorage.setItem(`tixkit:event:${eventId}:last-setup-section`, id);
              void adminApi.setEventSetupSection(eventId, id).then((result) => {
                if (!result.ok)
                  toast.error('This section is saved in this browser, but could not sync.');
              });
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      <section id="basics" className="scroll-mt-6">
        <Card>
          <CardHeader>
            <CardTitle>Basics</CardTitle>
          </CardHeader>
          <CardContent>
            <EventForm
              event={event}
              section="basics"
              autosave
              onSuccess={() => {
                void refetch();
                router.refresh();
              }}
            />
          </CardContent>
        </Card>
      </section>
      <section id="schedule" className="scroll-mt-6">
        <Card>
          <CardHeader>
            <CardTitle>Schedule and venue</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <EventForm event={event} section="schedule" autosave onSuccess={() => void refetch()} />
            <p className="text-sm text-muted-foreground">
              Venue fields are structured and country uses the ISO selector. Occurrence dates stay
              scoped to this event.
            </p>
          </CardContent>
        </Card>
      </section>
      <section id="sales" className="scroll-mt-6">
        <Card>
          <CardHeader>
            <CardTitle>Sales settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <EventForm event={event} section="sales" autosave onSuccess={() => void refetch()} />
            <p>
              Event capacity is a venue-level ceiling; ticket inventory pools determine what can be
              sold. Ticket, product, and event currency must remain coherent.
            </p>
            <Link className="font-medium text-primary" href={routes.eventTickets(eventId)}>
              Manage ticket inventory
            </Link>
            <span className="px-2">·</span>
            <Link
              className="font-medium text-primary"
              href={`${routes.eventTickets(eventId)}?section=fees-resale`}
            >
              Manage resale policy
            </Link>
          </CardContent>
        </Card>
        <div className="mt-4">
          <EventFeePolicyCard eventId={eventId} ticketTypes={ticketTypes ?? []} />
        </div>
      </section>
      <section id="media" className="scroll-mt-6">
        <Card>
          <CardHeader>
            <CardTitle>Media</CardTitle>
          </CardHeader>
          <CardContent>
            <EventMediaSettings event={event} onChanged={() => void refetch()} />
          </CardContent>
        </Card>
      </section>
      <section id="marketing-fields" className="scroll-mt-6">
        <Card>
          <CardHeader>
            <CardTitle>SEO and marketing</CardTitle>
          </CardHeader>
          <CardContent>
            <EventForm
              event={event}
              section="marketing"
              autosave
              onSuccess={() => void refetch()}
            />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
