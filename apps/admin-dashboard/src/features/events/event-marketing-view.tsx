'use client';

import * as React from 'react';
import { Save } from 'lucide-react';
import {
  type AdminMarketingIntegration,
  type AdminMarketingIntegrationProvider,
  adminApi,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { useAdminQuery } from '@/hooks/use-admin-table-data';

const EMPTY_MARKETING_INTEGRATIONS: AdminMarketingIntegration[] = [];

type MarketingDraft = {
  value: string;
  consentRequired: boolean;
  status: 'active' | 'disabled';
  saving: boolean;
  error?: string;
};

const MARKETING_PROVIDERS: Array<{
  provider: AdminMarketingIntegrationProvider;
  title: string;
  field: 'measurementId' | 'pixelId' | 'pixelUrl';
  placeholder: string;
}> = [
  {
    provider: 'ga4',
    title: 'Google Analytics 4',
    field: 'measurementId',
    placeholder: 'G-XXXXXXXXXX',
  },
  { provider: 'meta_pixel', title: 'Meta Pixel', field: 'pixelId', placeholder: '123456789012345' },
  {
    provider: 'generic_tag',
    title: 'Generic HTTPS Pixel',
    field: 'pixelUrl',
    placeholder: 'https://analytics.example/pixel',
  },
];

export function EventMarketingView({
  eventId,
  embedded = false,
}: {
  eventId: string;
  /** Compact layout for embedding in the edit-event drawer. */
  embedded?: boolean;
}) {
  const {
    data: marketingIntegrations = EMPTY_MARKETING_INTEGRATIONS,
    loading,
    error,
    refetch,
  } = useAdminQuery(['listMarketingIntegrations', eventId], () =>
    adminApi.listMarketingIntegrations(eventId),
  );

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
      <div className="space-y-4">
        {!embedded && <h2 className="text-xl font-semibold tracking-tight">Marketing</h2>}
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  return (
    <div className={embedded ? 'space-y-3' : 'space-y-6'}>
      {!embedded && (
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">Marketing Integrations</h2>
          <p className="text-sm text-muted-foreground">
            Connect analytics and tracking pixels to your checkout and event pages.
          </p>
        </div>
      )}
      <MarketingIntegrationsPanel
        eventId={eventId}
        integrations={marketingIntegrations}
        onSaved={refetch}
        compact={embedded}
      />
    </div>
  );
}

function MarketingIntegrationsPanel({
  eventId,
  integrations,
  onSaved,
  compact = false,
}: {
  eventId: string;
  integrations: AdminMarketingIntegration[];
  onSaved: () => void | Promise<void>;
  compact?: boolean;
}) {
  const [drafts, setDrafts] = React.useState<
    Record<AdminMarketingIntegrationProvider, MarketingDraft>
  >({
    ga4: { value: '', consentRequired: true, status: 'disabled', saving: false },
    meta_pixel: { value: '', consentRequired: true, status: 'disabled', saving: false },
    generic_tag: { value: '', consentRequired: true, status: 'disabled', saving: false },
  });

  React.useEffect(() => {
    setDrafts((current) => {
      const next = { ...current };
      for (const spec of MARKETING_PROVIDERS) {
        const integration = integrations.find((item) => item.provider === spec.provider);
        next[spec.provider] = {
          value:
            typeof integration?.config[spec.field] === 'string'
              ? String(integration.config[spec.field])
              : '',
          consentRequired: integration?.consentRequired ?? true,
          status: integration?.status ?? 'disabled',
          saving: false,
        };
      }
      return next;
    });
  }, [integrations]);

  async function saveProvider(spec: (typeof MARKETING_PROVIDERS)[number]) {
    const draft = drafts[spec.provider];
    setDrafts((current) => ({
      ...current,
      [spec.provider]: { ...current[spec.provider], saving: true, error: undefined },
    }));
    const result = await adminApi.upsertMarketingIntegration(eventId, {
      provider: spec.provider,
      config: { [spec.field]: draft.value.trim() },
      consentRequired: draft.consentRequired,
      status: draft.status,
    });
    setDrafts((current) => ({
      ...current,
      [spec.provider]: {
        ...current[spec.provider],
        saving: false,
        error: result.ok ? undefined : result.error.message,
      },
    }));
    if (result.ok) await onSaved();
  }

  return (
    <Card>
      <CardHeader className={compact ? 'pb-3' : undefined}>
        <CardTitle>Tracking Pixels</CardTitle>
      </CardHeader>
      <CardContent className={compact ? 'grid gap-4 sm:grid-cols-1' : 'grid gap-4 lg:grid-cols-3'}>
        {MARKETING_PROVIDERS.map((spec) => {
          const draft = drafts[spec.provider];
          const disabled = draft.saving || (draft.status === 'active' && !draft.value.trim());
          return (
            <div key={spec.provider} className="rounded-md border p-4">
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-semibold">{spec.title}</p>
                  {draft.error ? (
                    <p className="mt-1 text-xs text-destructive">{draft.error}</p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${spec.provider}-value`}>{spec.field}</Label>
                  <Input
                    id={`${spec.provider}-value`}
                    value={draft.value}
                    placeholder={spec.placeholder}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [spec.provider]: { ...current[spec.provider], value: event.target.value },
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor={`${spec.provider}-status`}>Active</Label>
                  <Switch
                    id={`${spec.provider}-status`}
                    checked={draft.status === 'active'}
                    onCheckedChange={(checked) =>
                      setDrafts((current) => ({
                        ...current,
                        [spec.provider]: {
                          ...current[spec.provider],
                          status: checked ? 'active' : 'disabled',
                        },
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor={`${spec.provider}-consent`}>Require consent</Label>
                  <Switch
                    id={`${spec.provider}-consent`}
                    checked={draft.consentRequired}
                    onCheckedChange={(checked) =>
                      setDrafts((current) => ({
                        ...current,
                        [spec.provider]: { ...current[spec.provider], consentRequired: checked },
                      }))
                    }
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void saveProvider(spec)}
                  disabled={disabled}
                >
                  <Save className="size-4" />
                  {draft.saving ? 'Saving' : 'Save'}
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
