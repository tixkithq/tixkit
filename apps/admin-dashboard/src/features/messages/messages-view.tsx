'use client'

import * as React from 'react'
import { Plus, MessageSquare, Mail, Smartphone } from 'lucide-react'
import {
  type AdminMessageCampaign,
  type AdminMessageDeliveryLog,
  type AdminMessageJob,
  type AdminMessageProviderEvent,
  adminApi,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAdminData } from '@/hooks/use-admin-data'
import { formatDate } from '@/lib/format'
import { MessageFormDialog } from './message-form'

export function MessagesView() {
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [selectedEventId, setSelectedEventId] = React.useState<string>('')
  const [selectedCampaignId, setSelectedCampaignId] = React.useState<string>('')

  const { data: eventsData } = useAdminData(() => adminApi.listEvents())
  const events = eventsData?.items ?? []

  const { data, loading, error, refetch } = useAdminData(
    () =>
      selectedEventId
        ? adminApi.listMessages(selectedEventId)
        : Promise.resolve({
            ok: true as const,
            data: [] as AdminMessageCampaign[],
          }),
    [selectedEventId]
  )

  const campaigns = data ?? []

  return (
    <div className='space-y-6'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <Select
          value={selectedEventId}
          onValueChange={(value) => {
            setSelectedEventId(value)
            setSelectedCampaignId('')
          }}
        >
          <SelectTrigger className='w-full max-w-xs' aria-label='Message event'>
            <SelectValue placeholder='Select an event' />
          </SelectTrigger>
          <SelectContent>
            {events.map((event) => (
              <SelectItem key={event.id} value={event.id}>
                {event.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={() => setDialogOpen(true)} disabled={!selectedEventId}>
          <Plus className='size-4' />
          New campaign
        </Button>
      </div>

      {!selectedEventId ? (
        <EmptyState
          icon={MessageSquare}
          title='Select an event'
          description='Choose an event to view and create message campaigns for its attendees.'
        />
      ) : loading ? (
        <div className='space-y-3'>
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className='h-24 w-full' />
          ))}
        </div>
      ) : error ? (
        <EmptyState
          icon={MessageSquare}
          title='Failed to load campaigns'
          description={error.message}
          action={<Button onClick={refetch}>Try again</Button>}
        />
      ) : campaigns.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title='No campaigns yet'
          description='Create a campaign to message attendees by channel and audience segment.'
          action={
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className='size-4' />
              New campaign
            </Button>
          }
        />
      ) : (
        <div className='space-y-3'>
          {campaigns.map((campaign) => (
            <Card key={campaign.id}>
              <CardContent className='flex items-center justify-between p-4'>
                <div className='flex items-center gap-3'>
                  {campaign.channel === 'email' ? (
                    <Mail className='size-5 text-muted-foreground' />
                  ) : (
                    <Smartphone className='size-5 text-muted-foreground' />
                  )}
                  <div>
                    <p className='font-medium'>{campaign.name}</p>
                    <p className='text-sm text-muted-foreground'>
                      {campaign.audienceLabel} · {campaign.queuedCount} queued
                      {campaign.sentCount > 0 && ` · ${campaign.sentCount} sent`}
                      {campaign.deliveredCount > 0 && ` · ${campaign.deliveredCount} delivered`}
                      {campaign.failedCount > 0 && ` · ${campaign.failedCount} failed`}
                      {campaign.suppressedCount > 0 && ` · ${campaign.suppressedCount} suppressed`}
                    </p>
                  </div>
                </div>
                <div className='flex items-center gap-3'>
                  <span className='text-sm text-muted-foreground'>
                    {formatDate(campaign.createdAt)}
                  </span>
                  <Badge variant='outline'>{campaign.status}</Badge>
                  <Button size='sm' variant='outline' onClick={() => setSelectedCampaignId(campaign.id)}>
                    Details
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {selectedEventId && selectedCampaignId && (
        <MessageCampaignDetailPanel eventId={selectedEventId} campaignId={selectedCampaignId} />
      )}

      <MessageFormDialog
        eventId={selectedEventId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSuccess={refetch}
      />
    </div>
  )
}

export function MessageCampaignDetailPanel({
  eventId,
  campaignId,
}: {
  eventId: string
  campaignId: string
}) {
  const detailState = useAdminData(
    () => adminApi.getMessage(eventId, campaignId),
    [eventId, campaignId]
  )
  const jobsState = useAdminData(
    () => adminApi.listMessageJobs(eventId, campaignId),
    [eventId, campaignId]
  )
  const deliveriesState = useAdminData(
    () => adminApi.listMessageDeliveryLogs(eventId, campaignId),
    [eventId, campaignId]
  )
  const providerEventsState = useAdminData(
    () => adminApi.listMessageProviderEvents(eventId, campaignId),
    [eventId, campaignId]
  )
  const detail = detailState.data

  if (detailState.loading) return <Skeleton className='h-64 w-full' />

  if (detailState.error || !detail) {
    return (
      <EmptyState
        icon={MessageSquare}
        title='Failed to load campaign detail'
        description={detailState.error?.message ?? 'Campaign detail was unavailable.'}
        action={<Button onClick={detailState.refetch}>Try again</Button>}
      />
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{detail.name}</CardTitle>
      </CardHeader>
      <CardContent className='space-y-5'>
        <div className='grid gap-3 sm:grid-cols-5'>
          <Metric label='Queued' value={detail.queuedCount} />
          <Metric label='Sent' value={detail.sentCount} />
          <Metric label='Delivered' value={detail.deliveredCount} />
          <Metric label='Failed' value={detail.failedCount} />
          <Metric label='Suppressed' value={detail.suppressedCount} />
        </div>
        <div className='grid gap-3 sm:grid-cols-3'>
          <Metric label='Email jobs' value={detail.queuedEmailJobs} />
          <Metric label='SMS jobs' value={detail.queuedSmsJobs} />
          <Metric label='Consent exclusions' value={detail.consentExclusions} />
        </div>
        <JobTable rows={jobsState.data ?? []} loading={jobsState.loading} error={jobsState.error?.message} />
        <DeliveryLogTable rows={deliveriesState.data ?? []} loading={deliveriesState.loading} error={deliveriesState.error?.message} />
        <ProviderEventTable rows={providerEventsState.data ?? []} loading={providerEventsState.loading} error={providerEventsState.error?.message} />
      </CardContent>
    </Card>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className='rounded-md border p-3'>
      <p className='text-xs text-muted-foreground'>{label}</p>
      <p className='text-lg font-semibold'>{value}</p>
    </div>
  )
}

function JobTable({ rows, loading, error }: { rows: AdminMessageJob[]; loading: boolean; error?: string }) {
  return (
    <RecordTable
      title='Jobs'
      loading={loading}
      error={error}
      rows={rows.map((row) => ({
        id: stringField(row.job, 'id'),
        channel: row.channel,
        status: stringField(row.job, 'status'),
        subject: stringField(row.job, 'to_email') || stringField(row.job, 'to_phone') || stringField(row.job, 'template_key'),
        updatedAt: stringField(row.job, 'updated_at'),
      }))}
    />
  )
}

function DeliveryLogTable({ rows, loading, error }: { rows: AdminMessageDeliveryLog[]; loading: boolean; error?: string }) {
  return (
    <RecordTable
      title='Delivery logs'
      loading={loading}
      error={error}
      rows={rows.map((row) => ({
        id: stringField(row.delivery, 'id'),
        channel: row.channel,
        status: stringField(row.delivery, 'status'),
        subject: stringField(row.delivery, 'provider_message_id') || stringField(row.delivery, 'job_id'),
        updatedAt: stringField(row.delivery, 'updated_at') || stringField(row.delivery, 'created_at'),
      }))}
    />
  )
}

function ProviderEventTable({ rows, loading, error }: { rows: AdminMessageProviderEvent[]; loading: boolean; error?: string }) {
  return (
    <RecordTable
      title='Provider events'
      loading={loading}
      error={error}
      rows={rows.map((row) => ({
        id: stringField(row.event, 'id') || stringField(row.event, 'provider_event_id'),
        channel: row.channel,
        status: stringField(row.event, 'event_type'),
        subject: stringField(row.event, 'provider_message_id') || stringField(row.event, 'job_id'),
        updatedAt: stringField(row.event, 'occurred_at') || stringField(row.event, 'created_at'),
      }))}
    />
  )
}

function RecordTable({
  title,
  loading,
  error,
  rows,
}: {
  title: string
  loading: boolean
  error?: string
  rows: Array<{ id: string; channel: string; status: string; subject: string; updatedAt: string }>
}) {
  return (
    <div className='rounded-md border'>
      <div className='flex items-center justify-between border-b px-3 py-2 text-sm'>
        <p className='font-medium'>{title}</p>
        <Badge variant={error ? 'destructive' : 'outline'}>{error ? 'error' : rows.length}</Badge>
      </div>
      {error ? (
        <p className='p-3 text-sm text-destructive'>{error}</p>
      ) : loading ? (
        <div className='space-y-2 p-3'>
          <Skeleton className='h-5 w-full' />
          <Skeleton className='h-5 w-2/3' />
        </div>
      ) : rows.length === 0 ? (
        <p className='p-3 text-sm text-muted-foreground'>No records.</p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full text-sm'>
            <thead className='bg-muted/50 text-left text-xs text-muted-foreground'>
              <tr>
                <th className='px-3 py-2 font-medium'>ID</th>
                <th className='px-3 py-2 font-medium'>Channel</th>
                <th className='px-3 py-2 font-medium'>Status</th>
                <th className='px-3 py-2 font-medium'>Subject</th>
                <th className='px-3 py-2 font-medium'>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${title}-${row.channel}-${row.id}`} className='border-t'>
                  <td className='px-3 py-2 font-mono text-xs'>{row.id || '-'}</td>
                  <td className='px-3 py-2'>{row.channel}</td>
                  <td className='px-3 py-2'>{row.status || '-'}</td>
                  <td className='px-3 py-2'>{row.subject || '-'}</td>
                  <td className='px-3 py-2'>{row.updatedAt ? formatDate(row.updatedAt) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  return typeof value === 'string' ? value : ''
}
