'use client';

import * as React from 'react';
import { Plus, MessageSquare, Mail, Smartphone } from 'lucide-react';
import { adminApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { formatDate } from '@/lib/format';
import { MessageFormDialog } from '@/features/messages/message-form';
import { MessageCampaignDetailPanel } from '@/features/messages/messages-view';

export function EventMessagesView({ eventId }: { eventId: string }) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = React.useState<string>('');
  const { data, loading, error, refetch } = useAdminQuery(['listMessages', eventId], () =>
    adminApi.listMessages(eventId),
  );

  const campaigns = data ?? [];

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  if (error && campaigns.length === 0) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="Failed to load campaigns"
        description={error.message}
        action={<Button onClick={refetch}>Try again</Button>}
      />
    );
  }

  if (campaigns.length === 0) {
    return (
      <>
        <EmptyState
          icon={MessageSquare}
          title="No campaigns yet"
          description="Create a campaign to message attendees of this event."
          action={
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="size-4" />
              New campaign
            </Button>
          }
        />
        <MessageFormDialog
          eventId={eventId}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSuccess={refetch}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="size-4" />
          New campaign
        </Button>
      </div>
      <div className="space-y-3">
        {campaigns.map((campaign) => (
          <Card key={campaign.id}>
            <CardContent className="flex flex-col items-start justify-between gap-3 p-4 sm:flex-row sm:items-center">
              <div className="flex min-w-0 items-start gap-3">
                {campaign.channel === 'email' ? (
                  <Mail className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                ) : (
                  <Smartphone className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0">
                  <p className="break-words font-medium">{campaign.name}</p>
                  <p className="break-words text-sm text-muted-foreground">
                    {campaign.audienceLabel} · {campaign.queuedCount} queued
                    {campaign.sentCount > 0 && ` · ${campaign.sentCount} sent`}
                    {campaign.deliveredCount > 0 && ` · ${campaign.deliveredCount} delivered`}
                    {campaign.failedCount > 0 && ` · ${campaign.failedCount} failed`}
                    {campaign.suppressedCount > 0 && ` · ${campaign.suppressedCount} suppressed`}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 sm:shrink-0 sm:justify-end">
                <span className="text-sm text-muted-foreground">
                  {formatDate(campaign.createdAt)}
                </span>
                <Badge variant="outline" className="shrink-0">
                  {campaign.status}
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => setSelectedCampaignId(campaign.id)}
                >
                  Details
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {selectedCampaignId && (
        <MessageCampaignDetailPanel eventId={eventId} campaignId={selectedCampaignId} />
      )}
      <MessageFormDialog
        eventId={eventId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSuccess={refetch}
      />
    </>
  );
}
