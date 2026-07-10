'use client';

import * as React from 'react';
import '@tixkit/widget';
import {
  EMBED_LIFECYCLE_NAMES,
  versionedLifecycleEventName,
  type EmbedMode,
  type EmbedTheme,
} from '@tixkit/embed-core';

export function EmbedPreviewClient({
  eventId,
  brandId,
  mode,
  theme,
  locale,
  products,
  themeTokens,
  previewId,
  apiBaseUrl,
}: {
  eventId: string;
  brandId: string;
  mode: string;
  theme: string;
  locale: string;
  products?: string;
  themeTokens?: string;
  previewId: string;
  apiBaseUrl: string;
}) {
  const ref = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const cleanups = EMBED_LIFECYCLE_NAMES.map((name) => {
      const eventName = versionedLifecycleEventName(name);
      const listener = (event: Event) => {
        const detail = (event as CustomEvent<Record<string, unknown>>).detail;
        if (!document.referrer) return;
        window.parent.postMessage(
          { source: 'tixkit-embed-studio-preview', previewId, eventName, detail },
          new URL(document.referrer).origin,
        );
      };
      element.addEventListener(eventName, listener);
      return () => element.removeEventListener(eventName, listener);
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [previewId]);

  const common = {
    ref,
    brand: brandId,
    event: eventId,
    locale,
    theme: theme as EmbedTheme,
    products,
    'theme-tokens': themeTokens,
    'checkout-mode': (mode === 'button' ? 'modal' : mode) as EmbedMode,
    'api-base-url': apiBaseUrl,
    'host-origin': typeof window === 'undefined' ? undefined : window.location.origin,
  };
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      {mode === 'button'
        ? React.createElement('tixkit-button', common, 'Buy tickets')
        : React.createElement('tixkit-widget', common)}
    </main>
  );
}
