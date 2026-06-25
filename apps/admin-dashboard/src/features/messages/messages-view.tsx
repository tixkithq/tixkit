'use client'

import * as React from 'react'
import { Plus, MessageSquare, Mail, Smartphone } from 'lucide-react'
import { type AdminMessageCampaign, adminApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
        <Select value={selectedEventId} onValueChange={setSelectedEventId}>
          <SelectTrigger className='w-full max-w-xs'>
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
                      {campaign.audience.replace(/_/g, ' ')} ·{' '}
                      {campaign.sentCount} sent
                      {campaign.failedCount > 0 &&
                        ` · ${campaign.failedCount} failed`}
                    </p>
                  </div>
                </div>
                <div className='flex items-center gap-3'>
                  <span className='text-sm text-muted-foreground'>
                    {formatDate(campaign.createdAt)}
                  </span>
                  <Badge variant='outline'>{campaign.status}</Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
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
