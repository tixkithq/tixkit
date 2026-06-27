'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { CalendarDays, Copy, MoreHorizontal, Pencil, Plus, Ticket, UserPlus } from 'lucide-react'
import {
  type AdminEventOccurrence,
  type AdminTicketType,
  type AdminWaitlistEntry,
  adminApi,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { EmptyState } from '@/components/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAdminData } from '@/hooks/use-admin-data'
import { formatCurrency, formatNumber, formatDateTime } from '@/lib/format'
import { TicketTypeStatusBadge } from './event-status-badge'
import { TicketTypeFormDrawer } from './ticket-type-form'

const EMPTY_TICKET_TYPES: AdminTicketType[] = []
const EMPTY_WAITLIST_ENTRIES: AdminWaitlistEntry[] = []
const EMPTY_OCCURRENCES: AdminEventOccurrence[] = []

export function EventTicketsView({ eventId }: { eventId: string }) {
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [editingTicket, setEditingTicket] = React.useState<
    AdminTicketType | undefined
  >(undefined)
  const { data, loading, error, refetch } = useAdminData(
    () => adminApi.listTicketTypes(eventId),
    [eventId]
  )
  const {
    data: waitlistData,
    loading: waitlistLoading,
    error: waitlistError,
    refetch: refetchWaitlist,
  } = useAdminData(
    () => adminApi.listWaitlist(eventId),
    [eventId]
  )
  const {
    data: occurrencesData,
    loading: occurrencesLoading,
    error: occurrencesError,
    refetch: refetchOccurrences,
  } = useAdminData(
    () => adminApi.listEventOccurrences(eventId),
    [eventId]
  )
  const [offeringEntryId, setOfferingEntryId] = React.useState<string | null>(null)
  const [claimUrlByEntryId, setClaimUrlByEntryId] = React.useState<Record<string, string>>({})

  const ticketTypes = data ?? EMPTY_TICKET_TYPES
  const occurrences = occurrencesData ?? EMPTY_OCCURRENCES
  const waitlistEntries = waitlistData?.items ?? EMPTY_WAITLIST_ENTRIES
  const waitlistSettings = waitlistData?.settings ?? {
    autoOfferEnabled: true,
    offerTtlMinutes: 1440,
  }
  const ticketNameById = React.useMemo(
    () => new Map(ticketTypes.map((ticket) => [ticket.id, ticket.name])),
    [ticketTypes]
  )
  const occurrenceNameById = React.useMemo(
    () => new Map(occurrences.map((occurrence) => [occurrence.id, occurrence.title])),
    [occurrences]
  )

  const handleCreate = () => {
    setEditingTicket(undefined)
    setDrawerOpen(true)
  }

  const handleEdit = (ticket: AdminTicketType) => {
    setEditingTicket(ticket)
    setDrawerOpen(true)
  }

  const handleOffer = async (entry: AdminWaitlistEntry) => {
    setOfferingEntryId(entry.id)
    const result = await adminApi.offerWaitlistEntry(eventId, entry.id)
    setOfferingEntryId(null)
    if (!result.ok) {
      toast.error(result.error.message)
      return
    }
    const claimUrl =
      result.data.claimUrl ??
      `/checkout?claimToken=${encodeURIComponent(result.data.claimToken)}`
    setClaimUrlByEntryId((current) => ({
      ...current,
      [entry.id]: claimUrl,
    }))
    await navigator.clipboard?.writeText(claimUrl).catch(() => undefined)
    toast.success('Waitlist offer created')
    void refetchWaitlist()
  }

  const handleSaveWaitlistSettings = async (settings: {
    autoOfferEnabled: boolean
    offerTtlMinutes: number
  }) => {
    const result = await adminApi.updateWaitlistSettings(eventId, settings)
    if (!result.ok) {
      toast.error(result.error.message)
      return
    }
    toast.success('Waitlist settings saved')
    void refetchWaitlist()
  }

  const handleCreateOccurrence = async (input: {
    title: string
    startsAt: string
    endsAt: string
    timezone: string
  }) => {
    const result = await adminApi.createEventOccurrence(eventId, input)
    if (!result.ok) {
      toast.error(result.error.message)
      return
    }
    toast.success('Occurrence created')
    void refetchOccurrences()
  }

  if (loading) {
    return (
      <div className='space-y-3'>
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className='h-16 w-full' />
        ))}
      </div>
    )
  }

  if (error && ticketTypes.length === 0) {
    return (
      <EmptyState
        icon={Ticket}
        title='Failed to load ticket types'
        description={error.message}
        action={<Button onClick={refetch}>Try again</Button>}
      />
    )
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
        <EmptyState
          icon={Ticket}
          title='No ticket types yet'
          description='Create a ticket type to start selling tickets for this event.'
          action={
            <Button onClick={handleCreate}>
              <Plus className='size-4' />
              Create ticket type
            </Button>
          }
        />
        <TicketTypeFormDrawer
          eventId={eventId}
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          onSuccess={() => {
            void refetch()
            void refetchOccurrences()
          }}
          ticketType={editingTicket}
        />
      </>
    )
  }

  const totalSold = ticketTypes.reduce((s, t) => s + t.quantitySold, 0)
  const totalCapacity = ticketTypes.reduce((s, t) => s + (t.quantityTotal ?? 0), 0)

  return (
    <>
      <div className='grid gap-4 sm:grid-cols-3'>
        <Card>
          <CardContent className='p-4'>
            <p className='text-sm text-muted-foreground'>Ticket Types</p>
            <p className='text-2xl font-bold'>{formatNumber(ticketTypes.length)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className='p-4'>
            <p className='text-sm text-muted-foreground'>Tickets Sold</p>
            <p className='text-2xl font-bold'>{formatNumber(totalSold)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className='p-4'>
            <p className='text-sm text-muted-foreground'>Total Capacity</p>
            <p className='text-2xl font-bold'>
              {totalCapacity > 0 ? formatNumber(totalCapacity) : '∞'}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className='flex justify-end'>
        <Button size='sm' onClick={handleCreate}>
          <Plus className='size-4' />
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

      <div className='rounded-md border'>
        <Table>
          <TableHeader>
            <TableRow className='hover:bg-transparent'>
              <TableHead>Name</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Occurrence</TableHead>
              <TableHead>Sold</TableHead>
              <TableHead>Sales Window</TableHead>
              <TableHead>Access Code</TableHead>
              <TableHead className='w-[50px]' />
            </TableRow>
          </TableHeader>
          <TableBody>
            {ticketTypes.map((tt) => (
              <TableRow key={tt.id}>
                <TableCell className='font-medium'>{tt.name}</TableCell>
                <TableCell>
                  {formatCurrency(tt.priceCents, tt.currency)}
                </TableCell>
                <TableCell>
                  <TicketTypeStatusBadge status={tt.status} />
                </TableCell>
                <TableCell className='text-sm text-muted-foreground'>
                  {tt.eventOccurrenceId
                    ? occurrenceNameById.get(tt.eventOccurrenceId) ?? tt.eventOccurrenceId
                    : 'All occurrences'}
                </TableCell>
                <TableCell>
                  {formatNumber(tt.quantitySold)}
                  {tt.quantityTotal
                    ? ` / ${formatNumber(tt.quantityTotal)}`
                    : ''}
                </TableCell>
                <TableCell className='text-sm text-muted-foreground'>
                  {tt.salesStartAt
                    ? `${formatDateTime(tt.salesStartAt)}`
                    : 'Now'}
                  {tt.salesEndAt ? ` – ${formatDateTime(tt.salesEndAt)}` : ''}
                </TableCell>
                <TableCell>
                  {tt.requiresAccessCode ? (
                    <Badge variant='secondary'>Required</Badge>
                  ) : (
                    <span className='text-muted-foreground'>No</span>
                  )}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant='ghost' size='icon' className='size-8'>
                        <MoreHorizontal className='size-4' />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align='end'>
                      <DropdownMenuLabel>Actions</DropdownMenuLabel>
                      <DropdownMenuItem onClick={() => handleEdit(tt)}>
                        <Pencil className='size-4' />
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
          void refetch()
          void refetchOccurrences()
        }}
        ticketType={editingTicket}
      />
    </>
  )
}

function OccurrencesTable({
  occurrences,
  loading,
  error,
  onCreate,
  onRetry,
}: {
  occurrences: AdminEventOccurrence[]
  loading: boolean
  error?: string
  onCreate: (input: { title: string; startsAt: string; endsAt: string; timezone: string }) => Promise<void>
  onRetry: () => void
}) {
  const [title, setTitle] = React.useState('')
  const [startsAt, setStartsAt] = React.useState('')
  const [endsAt, setEndsAt] = React.useState('')
  const [timezone, setTimezone] = React.useState('UTC')
  const [creating, setCreating] = React.useState(false)

  const create = async () => {
    if (!title.trim() || !startsAt || !endsAt || !timezone.trim()) {
      toast.error('Title, start, end, and timezone are required.')
      return
    }
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      toast.error('Occurrence end must be after start.')
      return
    }
    setCreating(true)
    await onCreate({
      title: title.trim(),
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      timezone: timezone.trim(),
    })
    setCreating(false)
    setTitle('')
    setStartsAt('')
    setEndsAt('')
  }

  if (loading) {
    return (
      <div className='space-y-3'>
        <Skeleton className='h-8 w-44' />
        <Skeleton className='h-24 w-full' />
      </div>
    )
  }

  if (error) {
    return (
      <EmptyState
        icon={CalendarDays}
        title='Failed to load occurrences'
        description={error}
        action={<Button onClick={onRetry}>Try again</Button>}
      />
    )
  }

  return (
    <Card>
      <CardContent className='space-y-4 p-4'>
        <div className='flex items-center gap-2'>
          <CalendarDays className='size-4 text-muted-foreground' />
          <h2 className='text-sm font-semibold'>Occurrences</h2>
        </div>
        <div className='grid gap-3 sm:grid-cols-[1fr_190px_190px_130px_auto]'>
          <div className='space-y-2'>
            <Label htmlFor='occurrence-title'>Title</Label>
            <Input
              id='occurrence-title'
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder='Friday evening'
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='occurrence-starts'>Starts</Label>
            <Input
              id='occurrence-starts'
              type='datetime-local'
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='occurrence-ends'>Ends</Label>
            <Input
              id='occurrence-ends'
              type='datetime-local'
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='occurrence-timezone'>Timezone</Label>
            <Input
              id='occurrence-timezone'
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </div>
          <div className='flex items-end'>
            <Button type='button' variant='outline' disabled={creating} onClick={create}>
              <Plus className='size-4' />
              Add
            </Button>
          </div>
        </div>
        {occurrences.length === 0 ? (
          <div className='flex items-center gap-3 text-sm text-muted-foreground'>
            <CalendarDays className='size-4' />
            No occurrences yet.
          </div>
        ) : (
          <div className='rounded-md border'>
            <Table>
              <TableHeader>
                <TableRow className='hover:bg-transparent'>
                  <TableHead>Title</TableHead>
                  <TableHead>Starts</TableHead>
                  <TableHead>Ends</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {occurrences.map((occurrence) => (
                  <TableRow key={occurrence.id}>
                    <TableCell className='font-medium'>{occurrence.title}</TableCell>
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
  )
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
  entries: AdminWaitlistEntry[]
  loading: boolean
  error?: string
  ticketNameById: Map<string, string>
  offeringEntryId: string | null
  claimUrlByEntryId: Record<string, string>
  settings: { autoOfferEnabled: boolean; offerTtlMinutes: number }
  onOffer: (entry: AdminWaitlistEntry) => void
  onSaveSettings: (settings: { autoOfferEnabled: boolean; offerTtlMinutes: number }) => Promise<void>
  onRetry: () => void
}) {
  const [autoOfferEnabled, setAutoOfferEnabled] = React.useState(settings.autoOfferEnabled)
  const [offerTtlMinutes, setOfferTtlMinutes] = React.useState(String(settings.offerTtlMinutes))
  const [savingSettings, setSavingSettings] = React.useState(false)

  React.useEffect(() => {
    setAutoOfferEnabled(settings.autoOfferEnabled)
    setOfferTtlMinutes(String(settings.offerTtlMinutes))
  }, [settings.autoOfferEnabled, settings.offerTtlMinutes])

  const saveSettings = async () => {
    const ttl = Number(offerTtlMinutes)
    if (!Number.isInteger(ttl) || ttl < 5 || ttl > 60 * 24 * 14) {
      toast.error('Offer window must be between 5 minutes and 14 days.')
      return
    }
    setSavingSettings(true)
    await onSaveSettings({ autoOfferEnabled, offerTtlMinutes: ttl })
    setSavingSettings(false)
  }

  if (loading) {
    return (
      <div className='space-y-3'>
        <Skeleton className='h-8 w-40' />
        <Skeleton className='h-24 w-full' />
      </div>
    )
  }

  if (error) {
    return (
      <EmptyState
        icon={UserPlus}
        title='Failed to load waitlist'
        description={error}
        action={<Button onClick={onRetry}>Try again</Button>}
      />
    )
  }

  if (entries.length === 0) {
    return (
      <Card>
        <CardContent className='space-y-4 p-4'>
          <WaitlistSettingsControls
            autoOfferEnabled={autoOfferEnabled}
            offerTtlMinutes={offerTtlMinutes}
            saving={savingSettings}
            onAutoOfferEnabledChange={setAutoOfferEnabled}
            onOfferTtlMinutesChange={setOfferTtlMinutes}
            onSave={saveSettings}
          />
          <div className='flex items-center gap-3 text-sm text-muted-foreground'>
            <UserPlus className='size-4' />
            No waitlist entries yet.
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className='space-y-4 p-4'>
        <div className='flex items-center gap-2'>
          <UserPlus className='size-4 text-muted-foreground' />
          <h2 className='text-sm font-semibold'>Waitlist</h2>
        </div>
        <WaitlistSettingsControls
          autoOfferEnabled={autoOfferEnabled}
          offerTtlMinutes={offerTtlMinutes}
          saving={savingSettings}
          onAutoOfferEnabledChange={setAutoOfferEnabled}
          onOfferTtlMinutesChange={setOfferTtlMinutes}
          onSave={saveSettings}
        />
        <div className='rounded-md border'>
          <Table>
            <TableHeader>
              <TableRow className='hover:bg-transparent'>
                <TableHead>Buyer</TableHead>
                <TableHead>Ticket</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Offer</TableHead>
                <TableHead className='w-[120px]' />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => {
                const claimUrl = claimUrlByEntryId[entry.id]
                return (
                  <TableRow key={entry.id}>
                    <TableCell>
                      <div className='min-w-0'>
                        <p className='truncate font-medium'>{entry.email}</p>
                        <p className='text-xs text-muted-foreground'>
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
                    <TableCell className='text-sm text-muted-foreground'>
                      {entry.offerExpiresAt
                        ? formatDateTime(entry.offerExpiresAt)
                        : 'Not offered'}
                    </TableCell>
                    <TableCell>
                      {claimUrl ? (
                        <Button
                          type='button'
                          variant='outline'
                          size='sm'
                          onClick={() => {
                            void navigator.clipboard?.writeText(claimUrl)
                            toast.success('Claim link copied')
                          }}
                        >
                          <Copy className='size-4' />
                          Copy
                        </Button>
                      ) : (
                        <Button
                          type='button'
                          variant='outline'
                          size='sm'
                          disabled={entry.status !== 'joined' || offeringEntryId === entry.id}
                          onClick={() => onOffer(entry)}
                        >
                          Offer
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

function WaitlistSettingsControls({
  autoOfferEnabled,
  offerTtlMinutes,
  saving,
  onAutoOfferEnabledChange,
  onOfferTtlMinutesChange,
  onSave,
}: {
  autoOfferEnabled: boolean
  offerTtlMinutes: string
  saving: boolean
  onAutoOfferEnabledChange: (value: boolean) => void
  onOfferTtlMinutesChange: (value: string) => void
  onSave: () => void
}) {
  return (
    <div className='grid gap-4 rounded-md border p-3 sm:grid-cols-[1fr_180px_auto] sm:items-end'>
      <div className='flex items-center justify-between gap-4 sm:block sm:space-y-2'>
        <Label htmlFor='waitlist-auto-offer'>Auto-offers</Label>
        <Switch
          id='waitlist-auto-offer'
          checked={autoOfferEnabled}
          onCheckedChange={onAutoOfferEnabledChange}
        />
      </div>
      <div className='space-y-2'>
        <Label htmlFor='waitlist-offer-ttl'>Claim window</Label>
        <Input
          id='waitlist-offer-ttl'
          type='number'
          min={5}
          max={60 * 24 * 14}
          value={offerTtlMinutes}
          onChange={(event) => onOfferTtlMinutesChange(event.target.value)}
        />
      </div>
      <Button type='button' variant='outline' disabled={saving} onClick={onSave}>
        Save
      </Button>
    </div>
  )
}

function WaitlistStatusBadge({ status }: { status: AdminWaitlistEntry['status'] }) {
  const variant = status === 'claimed' ? 'default' : status === 'joined' ? 'secondary' : 'outline'
  return <Badge variant={variant}>{status.replace('_', ' ')}</Badge>
}
