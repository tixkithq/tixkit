'use client';
/* oxlint-disable react/iframe-missing-sandbox -- Preview documents are isolated on the checkout origin, separate from authenticated admin state. */

import * as React from 'react';
import {
  EMBED_LIFECYCLE_NAMES,
  EMBED_BUTTON_SIZES,
  EMBED_BUTTON_VARIANTS,
  EMBED_MODES,
  EMBED_PLATFORMS,
  EMBED_THEMES,
  createEmbedNonce,
  generateEmbed,
  type EmbedMode,
  type EmbedPlatform,
  type EmbedTheme,
  type EmbedThemeTokens,
} from '@tixkit/embed-core';
import { Copy, Download, ExternalLink, Monitor, Smartphone } from 'lucide-react';
import { adminApi } from '@/lib/api';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiErrorState } from '@/components/api-error-state';

const WIDGET_URL = 'https://cdn.tixkit.com/widget/v0.1.0/tixkit-widget-0.1.0.js';
const WIDGET_INTEGRITY = 'sha384-dekV7a3DQg8bDdculs4uy24zS9CiyMfb4QpROp1Pb878LK63cHRC212CsRjzESAB';
const inputClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

type PreviewEvent = { eventName: string; detail: Record<string, unknown> };

export function EmbedStudio({ eventId }: { eventId: string }) {
  const {
    data: event,
    loading,
    error,
    refetch,
  } = useAdminQuery(['getEvent', eventId], () => adminApi.getEvent(eventId));
  const [mode, setMode] = React.useState<EmbedMode>('inline');
  const [platform, setPlatform] = React.useState<EmbedPlatform>('html');
  const [theme, setTheme] = React.useState<EmbedTheme>('auto');
  const [locale, setLocale] = React.useState('en-US');
  const [products, setProducts] = React.useState('');
  const [viewport, setViewport] = React.useState<'desktop' | 'mobile'>('desktop');
  const [events, setEvents] = React.useState<PreviewEvent[]>([]);
  const [copyStatus, setCopyStatus] = React.useState('');
  const [previewId, setPreviewId] = React.useState('');
  const [tokens, setTokens] = React.useState<EmbedThemeTokens>({
    colorPrimary: '#2563eb',
    colorSurface: '#ffffff',
    colorText: '#171717',
    colorMuted: '#6b7280',
    colorBorder: '#d1d5db',
    radius: 10,
    density: 'comfortable',
    fontFamily: 'system-ui',
    buttonSize: 'md',
    buttonVariant: 'solid',
  });
  const previewRef = React.useRef<HTMLIFrameElement>(null);
  const checkoutBaseUrl =
    process.env.NEXT_PUBLIC_CHECKOUT_BASE_URL ?? 'https://checkout.tixkit.com';

  React.useEffect(() => setPreviewId(createEmbedNonce()), []);

  React.useEffect(() => {
    const listener = (message: MessageEvent) => {
      if (
        message.origin !== new URL(checkoutBaseUrl).origin ||
        message.source !== previewRef.current?.contentWindow ||
        message.data?.source !== 'tixkit-embed-studio-preview' ||
        message.data?.previewId !== previewId ||
        typeof message.data.eventName !== 'string' ||
        !isPreviewLifecycle(message.data, eventId)
      )
        return;
      setEvents((current) => [message.data as PreviewEvent, ...current].slice(0, 30));
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [checkoutBaseUrl, eventId, previewId]);

  if (loading) return <output>Loading embed studio…</output>;
  if (error || !event)
    return (
      <ApiErrorState
        title="Embed studio unavailable"
        error={error ?? { status: 404, code: 'not_found', message: 'Event not found.' }}
        onRetry={refetch}
      />
    );

  const generatorOptions = {
    eventId,
    brandId: event.brandId ?? 'platform',
    mode,
    theme,
    locale,
    products: products || undefined,
    themeTokens: tokens,
    checkoutBaseUrl,
    widgetScriptUrl: WIDGET_URL,
    widgetIntegrity: WIDGET_INTEGRITY,
    includeLifecycle: true,
  } as const;
  const result = generateEmbed({ ...generatorOptions, platform });
  const preview = new URL('/embed-preview', checkoutBaseUrl);
  preview.searchParams.set('eventId', eventId);
  preview.searchParams.set('brand', event.brandId ?? 'platform');
  preview.searchParams.set('mode', mode);
  preview.searchParams.set('theme', theme);
  preview.searchParams.set('locale', locale);
  preview.searchParams.set('themeTokens', JSON.stringify(tokens));
  preview.searchParams.set('previewId', previewId);
  preview.searchParams.set('apiBaseUrl', checkoutBaseUrl);
  if (products) preview.searchParams.set('products', products);

  const copySnippet = async () => {
    if (!result.ok || !navigator.clipboard) {
      setCopyStatus('Copy unavailable. Select the generated code manually.');
      return;
    }
    try {
      await navigator.clipboard.writeText(result.snippet);
      setCopyStatus('Snippet copied.');
    } catch {
      setCopyStatus('Copy failed. Select the generated code manually.');
    }
  };
  const download = () => {
    const hostPage = generateEmbed({ ...generatorOptions, platform: 'html' });
    if (!hostPage.ok) return;
    const title = escapeHtmlText(event.title);
    const blob = new Blob(
      [
        `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} tickets</title></head><body><main><h1>${title}</h1>${hostPage.snippet}</main></body></html>`,
      ],
      { type: 'text/html' },
    );
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `tixkit-${eventId}-embed.html`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Embed studio</h1>
        <p className="text-sm text-muted-foreground">
          Generate a pinned, CSP-safe checkout embed for {event.title}.
        </p>
      </header>
      <div className="grid gap-6 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Mode">
              <select
                className={inputClass}
                value={mode}
                onChange={(e) => setMode(e.target.value as EmbedMode)}
              >
                {EMBED_MODES.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </Field>
            <Field label="Example">
              <select
                className={inputClass}
                value={platform}
                onChange={(e) => setPlatform(e.target.value as EmbedPlatform)}
              >
                {EMBED_PLATFORMS.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </Field>
            <Field label="Preview theme">
              <select
                className={inputClass}
                value={theme}
                onChange={(e) => setTheme(e.target.value as EmbedTheme)}
              >
                {EMBED_THEMES.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </Field>
            <Field label="Locale">
              <input
                className={inputClass}
                value={locale}
                onChange={(e) => setLocale(e.target.value)}
              />
            </Field>
            <Field label="Ticket/product preselection">
              <input
                className={inputClass}
                placeholder="tt_general,prod_merch"
                value={products}
                onChange={(e) => setProducts(e.target.value)}
              />
            </Field>
            {(
              ['colorPrimary', 'colorSurface', 'colorText', 'colorMuted', 'colorBorder'] as const
            ).map((key) => (
              <Field key={key} label={key}>
                <input
                  className={inputClass}
                  type="color"
                  value={tokens[key]}
                  onChange={(e) => setTokens((current) => ({ ...current, [key]: e.target.value }))}
                />
              </Field>
            ))}
            <Field label="Radius">
              <input
                className={inputClass}
                type="number"
                min="0"
                max="32"
                value={tokens.radius}
                onChange={(e) =>
                  setTokens((current) => ({ ...current, radius: Number(e.target.value) }))
                }
              />
            </Field>
            <Field label="Density">
              <select
                className={inputClass}
                value={tokens.density}
                onChange={(e) =>
                  setTokens((current) => ({
                    ...current,
                    density: e.target.value as 'compact' | 'comfortable',
                  }))
                }
              >
                <option>comfortable</option>
                <option>compact</option>
              </select>
            </Field>
            <Field label="Font family">
              <input
                className={inputClass}
                value={tokens.fontFamily}
                onChange={(e) =>
                  setTokens((current) => ({ ...current, fontFamily: e.target.value }))
                }
                placeholder="system-ui"
              />
            </Field>
            <Field label="Button size">
              <select
                className={inputClass}
                value={tokens.buttonSize}
                onChange={(e) =>
                  setTokens((current) => ({
                    ...current,
                    buttonSize: e.target.value as NonNullable<EmbedThemeTokens['buttonSize']>,
                  }))
                }
              >
                {EMBED_BUTTON_SIZES.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </Field>
            <Field label="Button variant">
              <select
                className={inputClass}
                value={tokens.buttonVariant}
                onChange={(e) =>
                  setTokens((current) => ({
                    ...current,
                    buttonVariant: e.target.value as NonNullable<EmbedThemeTokens['buttonVariant']>,
                  }))
                }
              >
                {EMBED_BUTTON_VARIANTS.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </Field>
          </CardContent>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Sandboxed preview</CardTitle>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={viewport === 'desktop' ? 'default' : 'outline'}
                  onClick={() => setViewport('desktop')}
                  aria-label="Desktop preview"
                  aria-pressed={viewport === 'desktop'}
                >
                  <Monitor className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant={viewport === 'mobile' ? 'default' : 'outline'}
                  onClick={() => setViewport('mobile')}
                  aria-label="Mobile preview"
                  aria-pressed={viewport === 'mobile'}
                >
                  <Smartphone className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="overflow-auto bg-muted p-4">
              <iframe
                ref={previewRef}
                title={`${viewport} checkout preview`}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                src={previewId ? preview.toString() : undefined}
                className={`mx-auto min-h-[32rem] border bg-background ${viewport === 'mobile' ? 'w-[390px]' : 'w-full'}`}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Generated code</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {result.ok ? (
                <>
                  <textarea
                    className="min-h-64 w-full rounded-md border bg-muted p-3 font-mono text-xs"
                    readOnly
                    value={result.snippet}
                    aria-label="Generated embed code"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={copySnippet}>
                      <Copy className="size-4" />
                      Copy snippet
                    </Button>
                    <Button variant="outline" onClick={download}>
                      <Download className="size-4" />
                      Download host page
                    </Button>
                  </div>
                  <output className="text-sm">{copyStatus}</output>
                  <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
                    {result.csp.header}
                  </pre>
                  <p className="text-sm">{result.instructions}</p>
                </>
              ) : (
                <ul role="alert" className="text-sm text-destructive">
                  {result.errors.map((issue) => (
                    <li key={`${issue.path}-${issue.message}`}>
                      {issue.path}: {issue.message}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Lifecycle events</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="max-h-56 space-y-2 overflow-auto font-mono text-xs" aria-live="polite">
                {events.length ? (
                  events.map((item, index) => (
                    <li key={`${item.eventName}-${index}`} className="rounded bg-muted p-2">
                      {item.eventName} {JSON.stringify(item.detail)}
                    </li>
                  ))
                ) : (
                  <li>No lifecycle events yet.</li>
                )}
              </ol>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Platform guidance</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                Webflow: place the pinned script in Footer Code and paste the element into an Embed
                block.
              </p>
              <p>
                Framer: place the pinned script in site custom code and paste the element into an
                Embed layer.
              </p>
              <a
                className="inline-flex items-center gap-1 underline"
                href="/help"
                target="_blank"
                rel="noreferrer"
              >
                Embedding documentation <ExternalLink className="size-3" />
              </a>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isPreviewLifecycle(
  data: Record<string, unknown>,
  eventId: string,
): data is PreviewEvent & { previewId: string; source: string } {
  if (typeof data.eventName !== 'string' || typeof data.detail !== 'object' || !data.detail) {
    return false;
  }
  const detail = data.detail as Record<string, unknown>;
  return EMBED_LIFECYCLE_NAMES.some(
    (name) =>
      data.eventName === `tixkit:v1:${name}` &&
      detail.name === name &&
      detail.contractVersion === '1.0' &&
      detail.eventId === eventId &&
      typeof detail.widgetId === 'string' &&
      typeof detail.timestamp === 'string',
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      <span>{label}</span>
      {children}
    </label>
  );
}
