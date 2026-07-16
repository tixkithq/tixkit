'use client';

import { sdkSnippetRegistry } from '@tixkit/docs-core';
import {
  CheckCircle2,
  Clipboard,
  ExternalLink,
  Server,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { dashboardDocUrl } from '@/lib/docs';
import { routes } from '@/lib/routes';
import { useRuntimeConfig } from '@/context/runtime-config-provider';
const apiVersion = '2026-01-01';

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
      <Clipboard className="size-4" aria-hidden="true" /> {copied ? 'Copied' : label}
      <span className="sr-only" aria-live="polite">
        {copied ? `${label} copied` : ''}
      </span>
    </Button>
  );
}

export function DeveloperConsoleGuide({
  activeKeys,
  activeWebhooks,
  totalWebhooks,
}: {
  activeKeys: number | null;
  activeWebhooks: number | null;
  totalWebhooks: number | null;
}) {
  const runtimeConfig = useRuntimeConfig();
  const configuredApiBaseUrl = runtimeConfig.platformApiBaseUrl;
  const [sdkId, setSdkId] = React.useState<(typeof sdkSnippetRegistry)[number]['id']>(
    sdkSnippetRegistry[0].id,
  );
  const [health, setHealth] = React.useState<'idle' | 'checking' | 'healthy' | 'unavailable'>(
    'idle',
  );
  const sdk = sdkSnippetRegistry.find((entry) => entry.id === sdkId) ?? sdkSnippetRegistry[0];
  const curl = `curl --fail-with-body --header "Authorization: Bearer $TIXKIT_API_KEY" "${configuredApiBaseUrl}/events"`;

  async function checkHealth() {
    setHealth('checking');
    try {
      const apiUrl = new URL(configuredApiBaseUrl);
      const response = await fetch(`${apiUrl.origin}/health`, { credentials: 'omit' });
      setHealth(response.ok ? 'healthy' : 'unavailable');
    } catch {
      setHealth('unavailable');
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Server className="size-4" aria-hidden="true" />
              Environment
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Mode</dt>
              <dd>{runtimeConfig.deploymentProfile}</dd>
              <dt className="text-muted-foreground">API version</dt>
              <dd>
                <code>{apiVersion}</code>
              </dd>
              <dt className="text-muted-foreground">API base URL</dt>
              <dd className="truncate">
                <code>{configuredApiBaseUrl}</code>
              </dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              <CopyButton value={configuredApiBaseUrl} label="Copy base URL" />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void checkHealth()}
                disabled={health === 'checking'}
              >
                {health === 'checking' ? 'Checking…' : 'Check API health'}
              </Button>
            </div>
            <output className="block text-xs text-muted-foreground">
              {health === 'healthy'
                ? 'API health endpoint is reachable.'
                : health === 'unavailable'
                  ? 'API health is unavailable. Verify the environment URL and service.'
                  : ''}
            </output>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="size-4" aria-hidden="true" />
              Credential readiness
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              {activeKeys === null ? (
                <>
                  <TriangleAlert className="mr-1 inline size-4 text-amber-600" aria-hidden="true" />
                  Credential status unavailable
                </>
              ) : activeKeys > 0 ? (
                <>
                  <CheckCircle2
                    className="mr-1 inline size-4 text-emerald-600"
                    aria-hidden="true"
                  />
                  {activeKeys} active API key{activeKeys === 1 ? '' : 's'}
                </>
              ) : (
                <>
                  <TriangleAlert className="mr-1 inline size-4 text-amber-600" aria-hidden="true" />
                  No active API key
                </>
              )}
            </p>
            <p className="text-muted-foreground">
              Secret keys are server-only and appear once at creation. This page never asks for,
              stores, or sends a secret.
            </p>
            {activeKeys === null ? null : (
              <Button asChild size="sm">
                <a href={routes.developerApiKeys}>
                  {activeKeys > 0 ? 'Manage keys' : 'Create scoped key'}
                </a>
              </Button>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Webhook health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              {activeWebhooks === null || totalWebhooks === null
                ? 'Webhook status unavailable. Retry the endpoint query above.'
                : `${activeWebhooks} active of ${totalWebhooks} configured endpoint${totalWebhooks === 1 ? '' : 's'}.`}
            </p>
            <p className="text-muted-foreground">
              Inactive or failing endpoints require URL, signature, response, or retry diagnosis
              before replay.
            </p>
            <div className="flex flex-wrap gap-3">
              <a className="font-medium text-primary" href={routes.developerWebhooks}>
                Manage webhooks
              </a>
              <a
                className="font-medium text-primary"
                href={dashboardDocUrl('webhookTroubleshooting', runtimeConfig)}
              >
                Troubleshoot
              </a>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Make a safe first API request</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Create a key with only event read access. Copy its one-time secret directly into a
            server shell or secret manager. Do not paste it into this page, a URL, logs, analytics,
            screenshots, or browser storage.
          </p>
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A keyboard-focusable scroll container is required by WCAG 2.1. */}
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs" tabIndex={0}>
            <code>{`export TIXKIT_API_KEY='one-time-secret-from-key-creation'\n${curl}`}</code>
          </pre>
          <div className="flex flex-wrap gap-2">
            <CopyButton value={curl} label="Copy request without secret" />
            <a
              className="inline-flex items-center gap-1 text-sm font-medium text-primary"
              href={dashboardDocUrl('firstApiCall', runtimeConfig)}
            >
              Expected response and failures <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Choose an SDK or framework</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="grid max-w-sm gap-1 text-sm font-medium">
            SDK
            <select
              className="rounded-md border bg-background px-3 py-2"
              value={sdk.id}
              onChange={(event) =>
                setSdkId(event.target.value as (typeof sdkSnippetRegistry)[number]['id'])
              }
            >
              {sdkSnippetRegistry.map((entry) => (
                <option value={entry.id} key={entry.id}>
                  {entry.label} · {entry.runtime}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-3 lg:grid-cols-3">
            <div>
              <p className="mb-1 text-sm font-medium">Install</p>
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A keyboard-focusable scroll container is required by WCAG 2.1. */}
              <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs" tabIndex={0}>
                <code>{sdk.install}</code>
              </pre>
            </div>
            <div>
              <p className="mb-1 text-sm font-medium">Initialize</p>
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A keyboard-focusable scroll container is required by WCAG 2.1. */}
              <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs" tabIndex={0}>
                <code>{sdk.initialization}</code>
              </pre>
            </div>
            <div>
              <p className="mb-1 text-sm font-medium">First request</p>
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A keyboard-focusable scroll container is required by WCAG 2.1. */}
              <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs" tabIndex={0}>
                <code>{sdk.firstRequest}</code>
              </pre>
            </div>
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <span className="text-muted-foreground">
              Package: <code>{sdk.packageName}</code> · API {sdk.apiVersion} · {sdk.supportStatus}
            </span>
            <a
              className="font-medium text-primary"
              href={dashboardDocUrl(sdk.docRouteId, runtimeConfig)}
            >
              Open {sdk.label} guide
            </a>
            <span className="text-muted-foreground">
              Runnable fixture: <code>{sdk.demoPath}</code>
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
