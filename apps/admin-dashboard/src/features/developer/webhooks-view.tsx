'use client'

import * as React from 'react'
import {
  Plus,
  Webhook,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Pause,
  Play,
  LoaderCircle,
} from 'lucide-react'
import {
  type AdminWebhookEndpoint,
  type AdminWebhookEvent,
  adminApi,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { WebhookFormDrawer } from './webhook-form'
import { useAdminData } from '@/hooks/use-admin-data'
import { formatDateTime } from '@/lib/format'
import { toast } from 'sonner'

const deliveryStatusTone = (
  status: AdminWebhookEvent['status'],
): 'default' | 'secondary' | 'destructive' => {
  if (status === 'succeeded') return 'default'
  if (status === 'failed') return 'destructive'
  return 'secondary'
}

export function WebhooksView() {
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [editingEndpoint, setEditingEndpoint] = React.useState<
    AdminWebhookEndpoint | undefined
  >(undefined)
  const [replayOpen, setReplayOpen] = React.useState(false)
  const [replayEndpoint, setReplayEndpoint] = React.useState<AdminWebhookEndpoint | null>(null)
  const [replayEvents, setReplayEvents] = React.useState<AdminWebhookEvent[]>([])
  const [replayLoading, setReplayLoading] = React.useState(false)
  const [replayingEventId, setReplayingEventId] = React.useState<string | null>(null)
  const { data, loading, error, refetch } = useAdminData(() =>
    adminApi.listWebhookEndpoints()
  )

  const endpoints = data ?? []

  const handleCreate = () => {
    setEditingEndpoint(undefined)
    setDrawerOpen(true)
  }

  const handleEdit = (endpoint: AdminWebhookEndpoint) => {
    setEditingEndpoint(endpoint)
    setDrawerOpen(true)
  }

  const openReplay = async (endpoint: AdminWebhookEndpoint) => {
    setReplayEndpoint(endpoint)
    setReplayOpen(true)
    setReplayEvents([])
    setReplayLoading(true)
    const result = await adminApi.listWebhookEvents(endpoint.id)
    setReplayLoading(false)
    if (result.ok) {
      setReplayEvents(result.data)
    } else {
      toast.error(result.error.message)
    }
  }

  const handleReplayEvent = async (event: AdminWebhookEvent) => {
    setReplayingEventId(event.id)
    // Replay targets the webhook EVENT id, not the endpoint id.
    const result = await adminApi.replayWebhookEvent(event.id)
    setReplayingEventId(null)
    if (result.ok) {
      toast.success(`Replay queued for ${event.eventType}`)
    } else {
      toast.error(result.error.message)
    }
  }

  const handleTogglePause = async (endpoint: AdminWebhookEndpoint) => {
    const newStatus = endpoint.status === 'active' ? 'paused' : 'active'
    const result = await adminApi.updateWebhookEndpoint(endpoint.id, {
      status: newStatus,
    })
    if (result.ok) {
      toast.success(`Endpoint ${newStatus === 'paused' ? 'paused' : 'resumed'}`)
      refetch()
    } else {
      toast.error(result.error.message)
    }
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

  if (error && endpoints.length === 0) {
    return (
      <EmptyState
        icon={Webhook}
        title='Failed to load webhooks'
        description={error.message}
        action={<Button onClick={refetch}>Try again</Button>}
      />
    )
  }

  if (endpoints.length === 0) {
    return (
      <>
        <EmptyState
          icon={Webhook}
          title='No webhook endpoints yet'
          description='Register an endpoint to receive event, order, and check-in notifications.'
          action={
            <Button onClick={handleCreate}>
              <Plus className='size-4' />
              Add endpoint
            </Button>
          }
        />
        <WebhookFormDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          endpoint={editingEndpoint}
          onSuccess={refetch}
        />
      </>
    )
  }

  return (
    <>
      <div className='flex justify-end'>
        <Button size='sm' onClick={handleCreate}>
          <Plus className='size-4' />
          Add endpoint
        </Button>
      </div>
      <div className='rounded-md border'>
        <Table>
          <TableHeader>
            <TableRow className='hover:bg-transparent'>
              <TableHead>URL</TableHead>
              <TableHead>Events</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Failures</TableHead>
              <TableHead>Last Delivery</TableHead>
              <TableHead className='w-[50px]' />
            </TableRow>
          </TableHeader>
          <TableBody>
            {endpoints.map((endpoint) => (
              <TableRow key={endpoint.id}>
                <TableCell>
                  <div className='flex flex-col'>
                    <span className='font-mono text-sm'>{endpoint.url}</span>
                    {endpoint.description && (
                      <span className='text-xs text-muted-foreground'>
                        {endpoint.description}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <div className='flex flex-wrap gap-1'>
                    {endpoint.events.slice(0, 2).map((event) => (
                      <Badge key={event} variant='secondary' className='text-xs'>
                        {event}
                      </Badge>
                    ))}
                    {endpoint.events.length > 2 && (
                      <Badge variant='outline' className='text-xs'>
                        +{endpoint.events.length - 2}
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      endpoint.status === 'active'
                        ? 'default'
                        : endpoint.status === 'paused'
                          ? 'secondary'
                          : 'destructive'
                    }
                  >
                    {endpoint.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {endpoint.failureCount > 0 ? (
                    <span className='text-red-600 dark:text-red-400'>
                      {endpoint.failureCount}
                    </span>
                  ) : (
                    '0'
                  )}
                </TableCell>
                <TableCell className='text-sm text-muted-foreground'>
                  {endpoint.lastDeliveryAt
                    ? formatDateTime(endpoint.lastDeliveryAt)
                    : 'Never'}
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
                      <DropdownMenuItem onClick={() => handleEdit(endpoint)}>
                        <Pencil className='size-4' />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleTogglePause(endpoint)}
                      >
                        {endpoint.status === 'active' ? (
                          <>
                            <Pause className='size-4' />
                            Pause
                          </>
                        ) : (
                          <>
                            <Play className='size-4' />
                            Resume
                          </>
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => openReplay(endpoint)}
                      >
                        <RotateCcw className='size-4' />
                        Replay events
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <WebhookFormDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        endpoint={editingEndpoint}
        onSuccess={refetch}
      />

      <Dialog open={replayOpen} onOpenChange={setReplayOpen}>
        <DialogContent className='sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle>Replay webhook events</DialogTitle>
            <DialogDescription>
              {replayEndpoint
                ? `Select a recent delivery to re-deliver to ${replayEndpoint.url}.`
                : 'Select a recent delivery to re-deliver.'}
            </DialogDescription>
          </DialogHeader>

          {replayLoading ? (
            <div className='flex items-center justify-center py-10'>
              <LoaderCircle className='size-6 animate-spin text-muted-foreground' />
            </div>
          ) : replayEvents.length === 0 ? (
            <div className='space-y-4 py-6'>
              <p className='text-sm text-muted-foreground'>
                No recent webhook events are available to replay for this
                endpoint.
              </p>
              <DialogFooter>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button disabled className='pointer-events-none'>
                        <RotateCcw className='size-4' />
                        Replay
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    No events available to replay
                  </TooltipContent>
                </Tooltip>
                <Button variant='outline' onClick={() => setReplayOpen(false)}>
                  Close
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className='max-h-80 space-y-2 overflow-y-auto'>
              {replayEvents.map((event) => (
                <div
                  key={event.id}
                  className='flex items-center justify-between rounded-lg border p-3'
                >
                  <div className='min-w-0 space-y-1'>
                    <div className='flex items-center gap-2'>
                      <span className='truncate font-mono text-sm'>
                        {event.eventType}
                      </span>
                      <Badge variant={deliveryStatusTone(event.status)}>
                        {event.status}
                      </Badge>
                    </div>
                    <p className='text-xs text-muted-foreground'>
                      {event.createdAt ? formatDateTime(event.createdAt) : ''}
                      {event.statusCode ? ` · HTTP ${event.statusCode}` : ''}
                      {` · ${event.attemptCount} attempt${event.attemptCount === 1 ? '' : 's'}`}
                    </p>
                  </div>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => handleReplayEvent(event)}
                    disabled={replayingEventId === event.id}
                  >
                    {replayingEventId === event.id ? (
                      <LoaderCircle className='size-4 animate-spin' />
                    ) : (
                      <RotateCcw className='size-4' />
                    )}
                    Replay
                  </Button>
                </div>
              ))}
            </div>
          )}

          {replayEvents.length > 0 ? (
            <DialogFooter>
              <Button variant='outline' onClick={() => setReplayOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
