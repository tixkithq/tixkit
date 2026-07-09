'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { CalendarDays, Plus } from 'lucide-react';
import { type AdminEventOccurrence, adminApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { formatDateTime } from '@/lib/format';

export function EventScheduleView({
  eventId,
  embedded = false,
}: {
  eventId: string;
  /** Compact layout for embedding in the edit-event drawer. */
  embedded?: boolean;
}) {
  const {
    data: occurrences = [],
    loading,
    error,
    refetch,
  } = useAdminQuery(['listEventOccurrences', eventId], () =>
    adminApi.listEventOccurrences(eventId),
  );

  const handleCreateOccurrence = async (input: {
    title: string;
    startsAt: string;
    endsAt: string;
    timezone: string;
  }): Promise<boolean> => {
    const result = await adminApi.createEventOccurrence(eventId, input);
    if (!result.ok) {
      toast.error(result.error.message);
      return false;
    }
    toast.success('Occurrence created');
    void refetch();
    return true;
  };

  if (loading) {
    return (
      <div className={embedded ? 'space-y-3' : 'space-y-6'}>
        {!embedded && <Skeleton className="h-8 w-48" />}
        <Skeleton className={embedded ? 'h-40 w-full' : 'h-64 w-full'} />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={CalendarDays}
        title="Failed to load schedule"
        description={error.message}
        action={<Button onClick={refetch}>Try again</Button>}
      />
    );
  }

  return (
    <div className={embedded ? 'space-y-3' : 'space-y-6'}>
      {!embedded && (
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">Schedule</h2>
          <p className="text-sm text-muted-foreground">
            Manage event dates and times. Ticket types can be scoped to specific occurrences.
          </p>
        </div>
      )}
      <OccurrencesTable
        occurrences={occurrences}
        onCreate={handleCreateOccurrence}
        compact={embedded}
      />
    </div>
  );
}

function OccurrencesTable({
  occurrences,
  onCreate,
  compact = false,
}: {
  occurrences: AdminEventOccurrence[];
  onCreate: (input: {
    title: string;
    startsAt: string;
    endsAt: string;
    timezone: string;
  }) => Promise<boolean>;
  compact?: boolean;
}) {
  const [title, setTitle] = React.useState('');
  const [startsAt, setStartsAt] = React.useState('');
  const [endsAt, setEndsAt] = React.useState('');
  const [timezone, setTimezone] = React.useState('UTC');
  const [creating, setCreating] = React.useState(false);

  const create = async () => {
    if (!title.trim() || !startsAt || !endsAt || !timezone.trim()) {
      toast.error('Title, start, end, and timezone are required.');
      return;
    }
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      toast.error('Occurrence end must be after start.');
      return;
    }
    setCreating(true);
    const success = await onCreate({
      title: title.trim(),
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      timezone: timezone.trim(),
    });
    setCreating(false);
    if (success) {
      setTitle('');
      setStartsAt('');
      setEndsAt('');
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <CalendarDays className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Occurrences</h3>
        </div>
        <div
          className={
            compact
              ? 'grid gap-3 sm:grid-cols-2'
              : 'grid gap-3 sm:grid-cols-[1fr_190px_190px_130px_auto]'
          }
        >
          <div className="space-y-2">
            <Label htmlFor="occurrence-title">Title</Label>
            <Input
              id="occurrence-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Friday evening"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="occurrence-starts">Starts</Label>
            <Input
              id="occurrence-starts"
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="occurrence-ends">Ends</Label>
            <Input
              id="occurrence-ends"
              type="datetime-local"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="occurrence-timezone">Timezone</Label>
            <Input
              id="occurrence-timezone"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </div>
          <div className={compact ? 'flex items-end sm:col-span-2' : 'flex items-end'}>
            <Button type="button" variant="outline" disabled={creating} onClick={create}>
              <Plus className="size-4" />
              Add
            </Button>
          </div>
        </div>
        {occurrences.length === 0 ? (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <CalendarDays className="size-4" />
            No occurrences yet.
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Title</TableHead>
                  <TableHead>Starts</TableHead>
                  <TableHead>Ends</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {occurrences.map((occurrence) => (
                  <TableRow key={occurrence.id}>
                    <TableCell className="font-medium">{occurrence.title}</TableCell>
                    <TableCell>{formatDateTime(occurrence.startsAt)}</TableCell>
                    <TableCell>{formatDateTime(occurrence.endsAt)}</TableCell>
                    <TableCell>
                      <Badge variant={occurrence.status === 'scheduled' ? 'secondary' : 'outline'}>
                        {occurrence.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
