'use client';

import * as React from 'react';
import Link from 'next/link';
import { KeyRound, Webhook, BookOpen, Code2 } from 'lucide-react';
import { adminApi } from '@/lib/api';
import { routes } from '@/lib/routes';
import { useDashboardDocUrl } from '@/lib/docs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { useBootstrap } from '@/context/bootstrap-provider';
import { ApiErrorState } from '@/components/api-error-state';
import { DeveloperConsoleGuide } from './developer-console-guide';

export function DeveloperOverview() {
  const docUrl = useDashboardDocUrl();
  const { organizationId } = useBootstrap();
  const {
    data: apiKeys,
    loading: keysLoading,
    error: keysError,
    refetch: refetchKeys,
  } = useAdminQuery(['listApiKeys', organizationId], () =>
    adminApi.listApiKeys(organizationId ? { organizationId } : undefined),
  );
  const {
    data: webhooks,
    loading: webhooksLoading,
    error: webhooksError,
    refetch: refetchWebhooks,
  } = useAdminQuery(['listWebhookEndpoints', organizationId], () =>
    adminApi.listWebhookEndpoints(organizationId ? { organizationId } : undefined),
  );

  const activeKeys = apiKeys?.length ?? null;
  const activeWebhooks = webhooks?.filter((w) => w.status === 'active').length ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Developer</h1>
          <p className="text-sm text-muted-foreground">
            API keys, webhooks, and platform integrations
          </p>
        </div>
        <Button asChild>
          <Link href={routes.developerApiKeys}>
            <KeyRound className="size-4" />
            Create API key
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">API Keys</CardTitle>
            <KeyRound className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {keysLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : keysError ? (
              <ApiErrorState
                error={keysError}
                onRetry={refetchKeys}
                className="border-0 bg-transparent p-0"
              />
            ) : (
              <>
                <div className="text-2xl font-bold">{activeKeys}</div>
                <p className="text-xs text-muted-foreground">
                  active key{(apiKeys ?? []).length === 1 ? '' : 's'}
                </p>
                <Button variant="link" size="sm" asChild className="mt-2 h-auto p-0">
                  <Link href={routes.developerApiKeys}>Manage keys →</Link>
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Webhooks</CardTitle>
            <Webhook className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {webhooksLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : webhooksError ? (
              <ApiErrorState
                error={webhooksError}
                onRetry={refetchWebhooks}
                className="border-0 bg-transparent p-0"
              />
            ) : (
              <>
                <div className="text-2xl font-bold">{activeWebhooks}</div>
                <p className="text-xs text-muted-foreground">
                  active endpoint{(webhooks ?? []).length === 1 ? '' : 's'}
                </p>
                <Button variant="link" size="sm" asChild className="mt-2 h-auto p-0">
                  <Link href={routes.developerWebhooks}>Manage endpoints →</Link>
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <DeveloperConsoleGuide
        activeKeys={keysLoading || keysError ? null : activeKeys}
        activeWebhooks={webhooksLoading || webhooksError ? null : activeWebhooks}
        totalWebhooks={webhooksLoading || webhooksError ? null : (webhooks?.length ?? 0)}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="size-5" />
            Resources
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <Code2 className="size-5 text-muted-foreground" />
              <div>
                <p className="font-medium">API Reference</p>
                <p className="text-sm text-muted-foreground">
                  Keys, scopes, idempotency, and server-side integration steps
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link href={docUrl('apiReference')}>Open reference</Link>
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <Webhook className="size-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Webhook Guide</p>
                <p className="text-sm text-muted-foreground">
                  Event types, payloads, and signatures
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link href={docUrl('webhookEvents')}>Open event catalog</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
