'use client';

import * as React from 'react';
import { toast } from 'sonner';
import {
  CalendarDays,
  Copy,
  MoreHorizontal,
  Pencil,
  Plus,
  ShieldCheck,
  Ticket,
  UserPlus,
} from 'lucide-react';
import {
  type AdminEventOccurrence,
  type AdminResalePolicy,
  type AdminTicketListing,
  type AdminTicketType,
  type AdminWaitlistEntry,
  adminApi,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAdminData } from '@/hooks/use-admin-data';
import { formatCurrency, formatNumber, formatDateTime } from '@/lib/format';
import { BoxOfficeOrderPanel } from './box-office-order-panel';
import { TicketTypeStatusBadge } from './event-status-badge';
import { TicketTypeFormDrawer } from './ticket-type-form';

const EMPTY_TICKET_TYPES: AdminTicketType[] = [];
const EMPTY_WAITLIST_ENTRIES: AdminWaitlistEntry[] = [];
const EMPTY_OCCURRENCES: AdminEventOccurrence[] = [];
const EMPTY_RESALE_LISTINGS: AdminTicketListing[] = [];

function buildResaleIdempotencyKey(eventId: string): string {
  const random =
    globalThis.crypto?.randomUUID?.().replaceAll('-', '') ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `resale_${eventId}_${random}`;
}

export function EventTicketsView({ eventId }: { eventId: string }) {
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editingTicket, setEditingTicket] = React.useState<AdminTicketType | undefined>(undefined);
  const { data, loading, error, refetch } = useAdminData(
    () => adminApi.listTicketTypes(eventId),
    [eventId],
  );
  const {
    data: waitlistData,
    loading: waitlistLoading,
    error: waitlistError,
    refetch: refetchWaitlist,
  } = useAdminData(() => adminApi.listWaitlist(eventId), [eventId]);
  const {
    data: occurrencesData,
    loading: occurrencesLoading,
    error: occurrencesError,
    refetch: refetchOccurrences,
  } = useAdminData(() => adminApi.listEventOccurrences(eventId), [eventId]);
  const {
    data: resalePolicy,
    loading: resalePolicyLoading,
    error: resalePolicyError,
    refetch: refetchResalePolicy,
  } = useAdminData(() => adminApi.getResalePolicy(eventId), [eventId]);
  const {
    data: resaleListingsData,
    loading: resaleListingsLoading,
    error: resaleListingsError,
    refetch: refetchResaleListings,
  } = useAdminData(() => adminApi.listResaleListings(eventId, { limit: 25 }), [eventId]);
  const [offeringEntryId, setOfferingEntryId] = React.useState<string | null>(null);
  const [claimUrlByEntryId, setClaimUrlByEntryId] = React.useState<Record<string, string>>({});

  const ticketTypes = data ?? EMPTY_TICKET_TYPES;
  const occurrences = occurrencesData ?? EMPTY_OCCURRENCES;
  const resaleListings = resaleListingsData?.items ?? EMPTY_RESALE_LISTINGS;
  const waitlistEntries = waitlistData?.items ?? EMPTY_WAITLIST_ENTRIES;
  const waitlistSettings = waitlistData?.settings ?? {
    autoOfferEnabled: true,
    offerTtlMinutes: 1440,
  };
  const ticketNameById = React.useMemo(
    () => new Map(ticketTypes.map((ticket) => [ticket.id, ticket.name])),
    [ticketTypes],
  );
  const occurrenceNameById = React.useMemo(
    () => new Map(occurrences.map((occurrence) => [occurrence.id, occurrence.title])),
    [occurrences],
  );

  const handleCreate = () => {
    setEditingTicket(undefined);
    setDrawerOpen(true);
  };

  const handleEdit = (ticket: AdminTicketType) => {
    setEditingTicket(ticket);
    setDrawerOpen(true);
  };

  const handleOffer = async (entry: AdminWaitlistEntry) => {
    setOfferingEntryId(entry.id);
    const result = await adminApi.offerWaitlistEntry(eventId, entry.id);
    setOfferingEntryId(null);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    const claimUrl =
      result.data.claimUrl ?? `/checkout?claimToken=${encodeURIComponent(result.data.claimToken)}`;
    setClaimUrlByEntryId((current) => ({
      ...current,
      [entry.id]: claimUrl,
    }));
    await navigator.clipboard?.writeText(claimUrl).catch(() => undefined);
    toast.success('Waitlist offer created');
    void refetchWaitlist();
  };

  const handleSaveWaitlistSettings = async (settings: {
    autoOfferEnabled: boolean;
    offerTtlMinutes: number;
  }) => {
    const result = await adminApi.updateWaitlistSettings(eventId, settings);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success('Waitlist settings saved');
    void refetchWaitlist();
  };

  const handleCreateOccurrence = async (input: {
    title: string;
    startsAt: string;
    endsAt: string;
    timezone: string;
  }) => {
    const result = await adminApi.createEventOccurrence(eventId, input);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success('Occurrence created');
    void refetchOccurrences();
  };

  const handleSaveResalePolicy = async (input: AdminResalePolicy) => {
    const result = await adminApi.updateResalePolicy(eventId, input);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success('Resale policy saved');
    void refetchResalePolicy();
  };

  const handleDelistResaleListing = async (listing: AdminTicketListing) => {
    const result = await adminApi.delistResaleListing(listing.id, {
      idempotencyKey: buildResaleIdempotencyKey(eventId),
    });
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success('Resale listing delisted');
    void refetchResaleListings();
  };

  if (loading && ticketTypes.length === 0) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (error && ticketTypes.length === 0) {
    return (
      <EmptyState
        icon={Ticket}
        title="Failed to load ticket types"
        description={error.message}
        action={<Button onClick={refetch}>Try again</Button>}
      />
    );
  }

  if (ticketTypes.length === 0) {
    return (
      <>
        <OccurrencesTable
          occurrences={occurrences}
          loading={occurrencesLoading}
          error={occurrencesError?.message}
          onCreate={handleCreateOccurrence}
          onRetry={refetchOccurrences}
        />
        <BoxOfficeOrderPanel
          eventId={eventId}
          ticketTypes={ticketTypes}
          occurrences={occurrences}
          onOrderCreated={() => {
            void refetch();
          }}
        />
        <ResalePolicyPanel
          policy={resalePolicy}
          listings={resaleListings}
          ticketNameById={ticketNameById}
          loading={resalePolicyLoading || resaleListingsLoading}
          error={resalePolicyError?.message ?? resaleListingsError?.message}
          onSavePolicy={handleSaveResalePolicy}
          onDelistListing={handleDelistResaleListing}
          onRetry={() => {
            void refetchResalePolicy();
            void refetchResaleListings();
          }}
        />
        <EmptyState
          icon={Ticket}
          title="No ticket types yet"
          description="Create a ticket type to start selling tickets for this event."
          action={
            <Button onClick={handleCreate}>
              <Plus className="size-4" />
              Create ticket type
            </Button>
          }
        />
        <TicketTypeFormDrawer
          eventId={eventId}
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          onSuccess={() => {
            void refetch();
            void refetchOccurrences();
          }}
          ticketType={editingTicket}
        />
      </>
    );
  }

  const totalSold = ticketTypes.reduce((s, t) => s + t.quantitySold, 0);
  const totalCapacity = ticketTypes.reduce((s, t) => s + (t.quantityTotal ?? 0), 0);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Ticket Types</p>
            <p className="text-2xl font-bold">{formatNumber(ticketTypes.length)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Tickets Sold</p>
            <p className="text-2xl font-bold">{formatNumber(totalSold)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Total Capacity</p>
            <p className="text-2xl font-bold">
              {totalCapacity > 0 ? formatNumber(totalCapacity) : '∞'}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={handleCreate}>
          <Plus className="size-4" />
          Create ticket type
        </Button>
      </div>

      <OccurrencesTable
        occurrences={occurrences}
        loading={occurrencesLoading}
        error={occurrencesError?.message}
        onCreate={handleCreateOccurrence}
        onRetry={refetchOccurrences}
      />

      <BoxOfficeOrderPanel
        eventId={eventId}
        ticketTypes={ticketTypes}
        occurrences={occurrences}
        onOrderCreated={() => {
          void refetch();
        }}
      />

      <ResalePolicyPanel
        policy={resalePolicy}
        listings={resaleListings}
        ticketNameById={ticketNameById}
        loading={resalePolicyLoading || resaleListingsLoading}
        error={resalePolicyError?.message ?? resaleListingsError?.message}
        onSavePolicy={handleSaveResalePolicy}
        onDelistListing={handleDelistResaleListing}
        onRetry={() => {
          void refetchResalePolicy();
          void refetchResaleListings();
        }}
      />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Occurrence</TableHead>
              <TableHead>Sold</TableHead>
              <TableHead>Sales Window</TableHead>
              <TableHead>Access Code</TableHead>
              <TableHead className="w-[50px]">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ticketTypes.map((tt) => (
              <TableRow key={tt.id}>
                <TableCell className="font-medium">{tt.name}</TableCell>
                <TableCell>{formatCurrency(tt.priceCents, tt.currency)}</TableCell>
                <TableCell>
                  <TicketTypeStatusBadge status={tt.status} />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {tt.eventOccurrenceId
                    ? (occurrenceNameById.get(tt.eventOccurrenceId) ?? tt.eventOccurrenceId)
                    : 'All occurrences'}
                </TableCell>
                <TableCell>
                  {formatNumber(tt.quantitySold)}
                  {tt.quantityTotal ? ` / ${formatNumber(tt.quantityTotal)}` : ''}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {tt.salesStartAt ? `${formatDateTime(tt.salesStartAt)}` : 'Now'}
                  {tt.salesEndAt ? ` – ${formatDateTime(tt.salesEndAt)}` : ''}
                </TableCell>
                <TableCell>
                  {tt.requiresAccessCode ? (
                    <Badge variant="secondary">Required</Badge>
                  ) : (
                    <span className="text-muted-foreground">No</span>
                  )}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={`Open actions for ${tt.name}`}
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>Actions</DropdownMenuLabel>
                      <DropdownMenuItem onClick={() => handleEdit(tt)}>
                        <Pencil className="size-4" />
                        Edit
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <WaitlistTable
        entries={waitlistEntries}
        loading={waitlistLoading}
        error={waitlistError?.message}
        ticketNameById={ticketNameById}
        offeringEntryId={offeringEntryId}
        claimUrlByEntryId={claimUrlByEntryId}
        settings={waitlistSettings}
        onOffer={handleOffer}
        onSaveSettings={handleSaveWaitlistSettings}
        onRetry={refetchWaitlist}
      />

      <TicketTypeFormDrawer
        eventId={eventId}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onSuccess={() => {
          void refetch();
          void refetchOccurrences();
        }}
        ticketType={editingTicket}
      />
    </>
  );
}

function OccurrencesTable({
  occurrences,
  loading,
  error,
  onCreate,
  onRetry,
}: {
  occurrences: AdminEventOccurrence[];
  loading: boolean;
  error?: string;
  onCreate: (input: {
    title: string;
    startsAt: string;
    endsAt: string;
    timezone: string;
  }) => Promise<void>;
  onRetry: () => void;
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
    await onCreate({
      title: title.trim(),
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      timezone: timezone.trim(),
    });
    setCreating(false);
    setTitle('');
    setStartsAt('');
    setEndsAt('');
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={CalendarDays}
        title="Failed to load occurrences"
        description={error}
        action={<Button onClick={onRetry}>Try again</Button>}
      />
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <CalendarDays className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Occurrences</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_190px_190px_130px_auto]">
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
          <div className="flex items-end">
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

function ResalePolicyPanel({
  policy,
  listings,
  ticketNameById,
  loading,
  error,
  onSavePolicy,
  onDelistListing,
  onRetry,
}: {
  policy?: AdminResalePolicy;
  listings: AdminTicketListing[];
  ticketNameById: Map<string, string>;
  loading: boolean;
  error?: string;
  onSavePolicy: (input: AdminResalePolicy) => Promise<void>;
  onDelistListing: (listing: AdminTicketListing) => Promise<void>;
  onRetry: () => void;
}) {
  const [enabled, setEnabled] = React.useState(policy?.enabled ?? false);
  const [maxMultiplier, setMaxMultiplier] = React.useState(String(policy?.maxMultiplier ?? 1));
  const [maxAbsoluteCents, setMaxAbsoluteCents] = React.useState(
    policy?.maxAbsoluteCents === undefined ? '' : String(policy.maxAbsoluteCents),
  );
  const [saving, setSaving] = React.useState(false);
  const [delistingId, setDelistingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    setEnabled(policy?.enabled ?? false);
    setMaxMultiplier(String(policy?.maxMultiplier ?? 1));
    setMaxAbsoluteCents(
      policy?.maxAbsoluteCents === undefined ? '' : String(policy.maxAbsoluteCents),
    );
  }, [policy?.enabled, policy?.maxMultiplier, policy?.maxAbsoluteCents]);

  const savePolicy = async () => {
    const multiplier = Number(maxMultiplier);
    if (!Number.isFinite(multiplier) || multiplier < 0) {
      toast.error('Maximum markup must be zero or greater.');
      return;
    }
    const absoluteCap =
      maxAbsoluteCents.trim().length === 0 ? undefined : Number(maxAbsoluteCents.trim());
    if (
      absoluteCap !== undefined &&
      (!Number.isInteger(absoluteCap) || absoluteCap < 0 || !Number.isSafeInteger(absoluteCap))
    ) {
      toast.error('Absolute cap must be a non-negative amount in cents.');
      return;
    }
    const input: AdminResalePolicy = {
      enabled,
      maxMultiplier: multiplier,
    };
    if (absoluteCap !== undefined) {
      input.maxAbsoluteCents = absoluteCap;
    }

    setSaving(true);
    try {
      await onSavePolicy(input);
    } finally {
      setSaving(false);
    }
  };

  const delist = async (listing: AdminTicketListing) => {
    setDelistingId(listing.id);
    try {
      await onDelistListing(listing);
    } finally {
      setDelistingId(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="Failed to load resale"
        description={error}
        action={<Button onClick={onRetry}>Try again</Button>}
      />
    );
  }

  return (
    <Card data-testid="resale-policy-panel">
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Resale</h2>
          <Badge variant={enabled ? 'secondary' : 'outline'}>
            {enabled ? 'Enabled' : 'Disabled'}
          </Badge>
        </div>
        <div className="grid gap-4 rounded-md border p-3 sm:grid-cols-[1fr_170px_190px_auto] sm:items-end">
          <div className="flex items-center justify-between gap-4 sm:block sm:space-y-2">
            <Label htmlFor="resale-enabled">Resale policy</Label>
            <Switch id="resale-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="resale-max-multiplier">Max markup</Label>
            <Input
              id="resale-max-multiplier"
              type="number"
              min={0}
              step="0.01"
              value={maxMultiplier}
              onChange={(event) => setMaxMultiplier(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="resale-absolute-cap">Absolute cap</Label>
            <Input
              id="resale-absolute-cap"
              type="number"
              min={0}
              step={1}
              value={maxAbsoluteCents}
              onChange={(event) => setMaxAbsoluteCents(event.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            aria-label="Save resale policy"
            onClick={savePolicy}
          >
            Save
          </Button>
        </div>
        {listings.length === 0 ? (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Ticket className="size-4" />
            No resale listings yet.
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Ticket</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Face value</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Seller</TableHead>
                  <TableHead className="w-[110px]">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listings.map((listing) => (
                  <TableRow key={listing.id}>
                    <TableCell className="font-medium">
                      {ticketNameById.get(listing.ticketId) ?? listing.ticketId}
                    </TableCell>
                    <TableCell>{formatCurrency(listing.priceCents, listing.currency)}</TableCell>
                    <TableCell>
                      {formatCurrency(listing.faceValueCents, listing.currency)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={listing.status === 'listed' ? 'secondary' : 'outline'}>
                        {listing.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {listing.sellerId}
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={listing.status !== 'listed' || delistingId === listing.id}
                        onClick={() => {
                          void delist(listing);
                        }}
                      >
                        Delist
                      </Button>
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

function WaitlistTable({
  entries,
  loading,
  error,
  ticketNameById,
  offeringEntryId,
  claimUrlByEntryId,
  settings,
  onOffer,
  onSaveSettings,
  onRetry,
}: {
  entries: AdminWaitlistEntry[];
  loading: boolean;
  error?: string;
  ticketNameById: Map<string, string>;
  offeringEntryId: string | null;
  claimUrlByEntryId: Record<string, string>;
  settings: { autoOfferEnabled: boolean; offerTtlMinutes: number };
  onOffer: (entry: AdminWaitlistEntry) => void;
  onSaveSettings: (settings: {
    autoOfferEnabled: boolean;
    offerTtlMinutes: number;
  }) => Promise<void>;
  onRetry: () => void;
}) {
  const [autoOfferEnabled, setAutoOfferEnabled] = React.useState(settings.autoOfferEnabled);
  const [offerTtlMinutes, setOfferTtlMinutes] = React.useState(String(settings.offerTtlMinutes));
  const [savingSettings, setSavingSettings] = React.useState(false);

  React.useEffect(() => {
    setAutoOfferEnabled(settings.autoOfferEnabled);
    setOfferTtlMinutes(String(settings.offerTtlMinutes));
  }, [settings.autoOfferEnabled, settings.offerTtlMinutes]);

  const saveSettings = async () => {
    const ttl = Number(offerTtlMinutes);
    if (!Number.isInteger(ttl) || ttl < 5 || ttl > 60 * 24 * 14) {
      toast.error('Offer window must be between 5 minutes and 14 days.');
      return;
    }
    setSavingSettings(true);
    await onSaveSettings({ autoOfferEnabled, offerTtlMinutes: ttl });
    setSavingSettings(false);
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={UserPlus}
        title="Failed to load waitlist"
        description={error}
        action={<Button onClick={onRetry}>Try again</Button>}
      />
    );
  }

  if (entries.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-4 p-4">
          <WaitlistSettingsControls
            autoOfferEnabled={autoOfferEnabled}
            offerTtlMinutes={offerTtlMinutes}
            saving={savingSettings}
            onAutoOfferEnabledChange={setAutoOfferEnabled}
            onOfferTtlMinutesChange={setOfferTtlMinutes}
            onSave={saveSettings}
          />
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <UserPlus className="size-4" />
            No waitlist entries yet.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <UserPlus className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Waitlist</h2>
        </div>
        <WaitlistSettingsControls
          autoOfferEnabled={autoOfferEnabled}
          offerTtlMinutes={offerTtlMinutes}
          saving={savingSettings}
          onAutoOfferEnabledChange={setAutoOfferEnabled}
          onOfferTtlMinutesChange={setOfferTtlMinutes}
          onSave={saveSettings}
        />
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Buyer</TableHead>
                <TableHead>Ticket</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Offer</TableHead>
                <TableHead className="w-[120px]">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => {
                const claimUrl = claimUrlByEntryId[entry.id];
                return (
                  <TableRow key={entry.id}>
                    <TableCell>
                      <div className="min-w-0">
                        <p className="truncate font-medium">{entry.email}</p>
                        <p className="text-xs text-muted-foreground">
                          {[entry.firstName, entry.lastName].filter(Boolean).join(' ') || 'Buyer'}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      {ticketNameById.get(entry.ticketTypeId) ?? entry.ticketTypeId}
                    </TableCell>
                    <TableCell>{formatNumber(entry.quantity)}</TableCell>
                    <TableCell>
                      <WaitlistStatusBadge status={entry.status} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {entry.offerExpiresAt ? formatDateTime(entry.offerExpiresAt) : 'Not offered'}
                    </TableCell>
                    <TableCell>
                      {claimUrl ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            void navigator.clipboard?.writeText(claimUrl);
                            toast.success('Claim link copied');
                          }}
                        >
                          <Copy className="size-4" />
                          Copy
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={entry.status !== 'joined' || offeringEntryId === entry.id}
                          onClick={() => onOffer(entry)}
                        >
                          Offer
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function WaitlistSettingsControls({
  autoOfferEnabled,
  offerTtlMinutes,
  saving,
  onAutoOfferEnabledChange,
  onOfferTtlMinutesChange,
  onSave,
}: {
  autoOfferEnabled: boolean;
  offerTtlMinutes: string;
  saving: boolean;
  onAutoOfferEnabledChange: (value: boolean) => void;
  onOfferTtlMinutesChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="grid gap-4 rounded-md border p-3 sm:grid-cols-[1fr_180px_auto] sm:items-end">
      <div className="flex items-center justify-between gap-4 sm:block sm:space-y-2">
        <Label htmlFor="waitlist-auto-offer">Auto-offers</Label>
        <Switch
          id="waitlist-auto-offer"
          checked={autoOfferEnabled}
          onCheckedChange={onAutoOfferEnabledChange}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="waitlist-offer-ttl">Claim window</Label>
        <Input
          id="waitlist-offer-ttl"
          type="number"
          min={5}
          max={60 * 24 * 14}
          value={offerTtlMinutes}
          onChange={(event) => onOfferTtlMinutesChange(event.target.value)}
        />
      </div>
      <Button type="button" variant="outline" disabled={saving} onClick={onSave}>
        Save
      </Button>
    </div>
  );
}

function WaitlistStatusBadge({ status }: { status: AdminWaitlistEntry['status'] }) {
  const variant = status === 'claimed' ? 'default' : status === 'joined' ? 'secondary' : 'outline';
  return <Badge variant={variant}>{status.replace('_', ' ')}</Badge>;
}
