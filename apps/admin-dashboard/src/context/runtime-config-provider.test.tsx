import { useEffect } from 'react';
import { render, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminUserProvider, useAdminUser } from './admin-user-provider';
import { RuntimeConfigProvider, useRuntimeConfig } from './runtime-config-provider';
import { defaultTestRuntimeConfig } from '@/test/runtime-config';
import { DeveloperConsoleGuide } from '@/features/developer/developer-console-guide';
import { EmbedStudio } from '@/features/events/embed-studio';
import { publicEventUrl } from '@/lib/event-links';
import { useDashboardDocUrl } from '@/lib/docs';
import {
  getBrowserRuntimeConfig,
  resetBrowserRuntimeConfigForTests,
} from '@/lib/runtime-config-browser';

function RuntimeProbe() {
  const config = useRuntimeConfig();
  const user = useAdminUser();
  return <output>{`${config.apiBaseUrl}|${config.checkoutUrl}|${user.email}`}</output>;
}

function DocsProbe() {
  const docUrl = useDashboardDocUrl();
  return <a href={docUrl('apiReference')}>API docs</a>;
}

describe('request-scoped runtime configuration SSR', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetBrowserRuntimeConfigForTests();
  });

  it('renders the auth shell, developer guide, and embed loading shell without document', () => {
    vi.stubGlobal('document', undefined);
    const html = renderToString(
      <RuntimeConfigProvider config={defaultTestRuntimeConfig}>
        <AdminUserProvider>
          <RuntimeProbe />
          <DocsProbe />
          <DeveloperConsoleGuide activeKeys={null} activeWebhooks={null} totalWebhooks={null} />
          <EmbedStudio eventId="evt_1" />
        </AdminUserProvider>
      </RuntimeConfigProvider>,
    );
    expect(html).toContain('http://localhost:4000');
    expect(html).toContain('organizer@localhost');
    expect(html).toContain('http://localhost:3002/reference/api');
    expect(html).toContain('Loading embed studio');
  });

  it('keeps two SSR snapshots isolated without stale origins', () => {
    vi.stubGlobal('document', undefined);
    const renderSnapshot = (origin: string) =>
      renderToString(
        <RuntimeConfigProvider
          config={{
            ...defaultTestRuntimeConfig,
            apiBaseUrl: origin,
            platformApiBaseUrl: `${origin}/v1`,
            checkoutUrl: `${origin}/checkout`,
          }}
        >
          <AdminUserProvider>
            <RuntimeProbe />
            <DocsProbe />
          </AdminUserProvider>
        </RuntimeConfigProvider>,
      );
    const first = renderSnapshot('https://one.example.test');
    const second = renderSnapshot('https://two.example.test');
    expect(first).toContain('https://one.example.test');
    expect(first).not.toContain('https://two.example.test');
    expect(second).toContain('https://two.example.test');
    expect(second).not.toContain('https://one.example.test');
  });

  it('builds public links from an explicit SSR config without reading document', () => {
    vi.stubGlobal('document', undefined);
    expect(publicEventUrl({ id: 'evt_1', slug: 'launch' }, [], defaultTestRuntimeConfig)).toBe(
      'http://localhost:3000/e/evt_1',
    );
  });

  it('does not bind browser configuration from an abandoned render', () => {
    resetBrowserRuntimeConfigForTests();
    function AbortedChild(): never {
      throw new Error('abandoned render');
    }
    expect(() =>
      render(
        <RuntimeConfigProvider config={defaultTestRuntimeConfig}>
          <AbortedChild />
        </RuntimeConfigProvider>,
      ),
    ).toThrow(/abandoned render/u);
    expect(() => getBrowserRuntimeConfig()).toThrow('not initialized');
  });

  it('binds configuration before descendant passive effects can issue requests', async () => {
    let observed: string | undefined;
    function RequestEffect() {
      useEffect(() => {
        observed = getBrowserRuntimeConfig().apiBaseUrl;
      }, []);
      return null;
    }
    render(
      <RuntimeConfigProvider config={defaultTestRuntimeConfig}>
        <RequestEffect />
      </RuntimeConfigProvider>,
    );
    await waitFor(() => expect(observed).toBe(defaultTestRuntimeConfig.apiBaseUrl));
  });
});
