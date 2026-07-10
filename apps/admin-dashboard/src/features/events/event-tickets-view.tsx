'use client';

import * as React from 'react';
import { toast } from 'sonner';
import {
  Copy,
  MoreHorizontal,
  Pencil,
  Plus,
  ReceiptText,
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
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { cn } from '@/lib/utils';
import { formatCurrency, formatNumber, formatDateTime } from '@/lib/format';
import { BoxOfficeOrderPanel } from './box-office-order-panel';
import { EventFeePolicyCard } from './event-fee-policy-card';
import { TicketTypeStatusBadge } from './event-status-badge';
import { TicketTypeFormDrawer } from './ticket-type-form';

const EMPTY_TICKET_TYPES: AdminTicketType[] = [];
const EMPTY_WAITLIST_ENTRIES: AdminWaitlistEntry[] = [];
const EMPTY_OCCURRENCES: AdminEventOccurrence[] = [];
const EMPTY_RESALE_LISTINGS: AdminTicketListing[] = [];

const TICKET_TAB_ITEMS = [
  { value: 'tickets', label: 'Tickets', icon: Ticket },
  { value: 'box-office', label: 'Box Office', icon: ReceiptText },
  { value: 'fees-resale', label: 'Fees & Resale', icon: ShieldCheck },
  { value: 'waitlist', label: 'Waitlist', icon: UserPlus },
] as const;

function buildResaleIdempotencyKey(eventId: string): string {
  const random =
    globalThis.crypto?.randomUUID?.().replaceAll('-', '') ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `resale_${eventId}_${random}`;
}

async function copyClaimLinkToClipboard(claimUrl: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText !== 'function') {
    toast.error('Claim link ready. Copy it manually from the row.');
    return false;
  }

  try {
    await clipboard.writeText(claimUrl);
    toast.success('Claim link copied');
    return true;
  } catch {
    toast.error('Claim link ready. Copy it manually from the row.');
    return false;
  }
}

export function EventTicketsView({ eventId }: { eventId: string }) {
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editingTicket, setEditingTicket] = React.useState<AdminTicketType | undefined>(undefined);
  const [activeTab, setActiveTab] = React.useState('tickets');
  const { data, loading, error, refetch } = useAdminQuery(['listTicketTypes', eventId], () =>
    adminApi.listTicketTypes(eventId),
  );
  const { data: event } = useAdminQuery(['getEvent', eventId, 'box-office'], () =>
    adminApi.getEvent(eventId),
  );
  const {
    data: waitlistData,
    loading: waitlistLoading,
    error: waitlistError,
    refetch: refetchWaitlist,
  } = useAdminQuery(['listWaitlist', eventId], () => adminApi.listWaitlist(eventId));
  const { data: occurrencesData, refetch: refetchOccurrences } = useAdminQuery(
    ['listEventOccurrences', eventId],
    () => adminApi.listEventOccurrences(eventId),
  );
  const {
    data: resalePolicy,
    loading: resalePolicyLoading,
    error: resalePolicyError,
    refetch: refetchResalePolicy,
  } = useAdminQuery(['getResalePolicy', eventId], () => adminApi.getResalePolicy(eventId));
  const {
    data: resaleListingsData,
    loading: resaleListingsLoading,
    error: resaleListingsError,
    refetch: refetchResaleListings,
  } = useAdminQuery(['listResaleListings', eventId], () =>
    adminApi.listResaleListings(eventId, { limit: 25 }),
  );
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
    toast.success('Waitlist offer created');
    await copyClaimLinkToClipboard(claimUrl);
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

  const handleSaveResalePolicy = async (input: AdminResalePolicy) => {
    const result = await adminApi.updateResalePolicy(eventId, input);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    await refetchResalePolicy();
    toast.success('Resale policy saved');
  };

  const handleDelistResaleListing = async (listing: AdminTicketListing) => {
    const result = await adminApi.delistResaleListing(listing.id, {
      idempotencyKey: buildResaleIdempotencyKey(eventId),
    });
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    await refetchResaleListings();
    toast.success('Resale listing delisted');
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
      <div className="space-y-6">
        <nav>
          <ul role="tablist" className="flex flex-row flex-wrap gap-1">
            {TICKET_TAB_ITEMS.map((tab) => {
              const isActive = activeTab === tab.value;
              return (
                <li key={tab.value}>
                  <button
                    type="button"
                    role="tab"
                    id={`${tab.value}-tab`}
                    aria-selected={isActive}
                    aria-controls={`${tab.value}-panel`}
                    onClick={() => setActiveTab(tab.value)}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-foreground',
                      isActive ? 'bg-accent text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <tab.icon className="size-4" />
                    {tab.label}
                    {tab.value === 'waitlist' && waitlistEntries.length > 0 && (
                      <Badge variant="secondary" className="ml-1 tabular-nums">
                        {formatNumber(waitlistEntries.length)}
                      </Badge>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {activeTab === 'tickets' && (
          <div
            role="tabpanel"
            id="tickets-panel"
            aria-labelledby="tickets-tab"
            className="space-y-4"
          >
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
                    {totalCapacity > 0 ? formatNumber(totalCapacity) : '\u221e'}
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
                        {tt.salesEndAt ? ` \u2013 ${formatDateTime(tt.salesEndAt)}` : ''}
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
          </div>
        )}

        {activeTab === 'box-office' && (
          <div
            role="tabpanel"
            id="box-office-panel"
            aria-labelledby="box-office-tab"
            className="space-y-4"
          >
            {event ? (
              <BoxOfficeOrderPanel
                eventId={eventId}
                event={event}
                ticketTypes={ticketTypes}
                occurrences={occurrences}
                onOrderCreated={() => {
                  void refetch();
                }}
              />
            ) : (
              <Skeleton className="h-64 w-full" />
            )}
          </div>
        )}

        {activeTab === 'fees-resale' && (
          <div
            role="tabpanel"
            id="fees-resale-panel"
            aria-labelledby="fees-resale-tab"
            className="space-y-4"
          >
            <EventFeePolicyCard eventId={eventId} ticketTypes={ticketTypes} />
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
          </div>
        )}

        {activeTab === 'waitlist' && (
          <div
            role="tabpanel"
            id="waitlist-panel"
            aria-labelledby="waitlist-tab"
            className="space-y-4"
          >
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
          </div>
        )}
      </div>

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
  const [maxAbsoluteDollars, setMaxAbsoluteDollars] = React.useState(
    policy?.maxAbsoluteCents === undefined ? '' : String(policy.maxAbsoluteCents / 100),
  );
  const [saving, setSaving] = React.useState(false);
  const [delistingId, setDelistingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    setEnabled(policy?.enabled ?? false);
    setMaxMultiplier(String(policy?.maxMultiplier ?? 1));
    setMaxAbsoluteDollars(
      policy?.maxAbsoluteCents === undefined ? '' : String(policy.maxAbsoluteCents / 100),
    );
  }, [policy?.enabled, policy?.maxMultiplier, policy?.maxAbsoluteCents]);

  const savePolicy = async () => {
    const multiplier = Number(maxMultiplier);
    if (!Number.isFinite(multiplier) || multiplier < 0) {
      toast.error('Maximum markup must be zero or greater.');
      return;
    }
    const absoluteCapDollars =
      maxAbsoluteDollars.trim().length === 0 ? undefined : Number(maxAbsoluteDollars.trim());
    if (
      absoluteCapDollars !== undefined &&
      (!Number.isFinite(absoluteCapDollars) || absoluteCapDollars < 0)
    ) {
      toast.error('Absolute cap must be a non-negative amount.');
      return;
    }
    const input: AdminResalePolicy = {
      enabled,
      maxMultiplier: multiplier,
    };
    if (absoluteCapDollars !== undefined) {
      input.maxAbsoluteCents = Math.round(absoluteCapDollars * 100);
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
            <Label htmlFor="resale-absolute-cap">Absolute cap ($)</Label>
            <Input
              id="resale-absolute-cap"
              type="number"
              min={0}
              step={0.01}
              placeholder="60.00"
              value={maxAbsoluteDollars}
              onChange={(event) => setMaxAbsoluteDollars(event.target.value)}
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
                <TableHead className="w-[260px]">
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
                        <div className="flex max-w-[260px] flex-col gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="w-fit"
                            onClick={() => {
                              void copyClaimLinkToClipboard(claimUrl);
                            }}
                          >
                            <Copy className="size-4" />
                            Copy
                          </Button>
                          <Input
                            readOnly
                            aria-label={`Claim link for ${entry.email}`}
                            className="h-8 text-xs"
                            value={claimUrl}
                            onFocus={(event) => event.currentTarget.select()}
                          />
                        </div>
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
