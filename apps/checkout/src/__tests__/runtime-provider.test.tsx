import { useEffect } from 'react';
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeConfigProvider } from '@/context/runtime-config-provider';
import {
  getBrowserRuntimeConfig,
  resetBrowserRuntimeConfigForTests,
} from '@/lib/runtime-config-browser';
import type { PublicCheckoutRuntimeConfig } from '@/lib/runtime-config-contract';

function config(apiBaseUrl: string): PublicCheckoutRuntimeConfig {
  const suffix = apiBaseUrl.includes('committed') ? '2' : '1';
  return {
    schemaVersion: '1',
    deploymentProfile: 'test',
    apiBaseUrl,
    platformApiBaseUrl: `${apiBaseUrl}/v1`,
    checkoutUrl: 'https://checkout.tixkit.com',
    mediaOrigin: 'https://media.example.test',
    buildRevision: `test-${suffix}`,
    configFingerprint: `sha256:${suffix.repeat(64)}`,
  };
}

afterEach(() => {
  resetBrowserRuntimeConfigForTests();
  vi.restoreAllMocks();
});

describe('RuntimeConfigProvider commit boundary', () => {
  it('does not bind configuration from an abandoned render', () => {
    function AbortedChild(): never {
      throw new Error('abort render');
    }
    expect(() =>
      render(
        <RuntimeConfigProvider config={config('https://aborted.example.test')}>
          <AbortedChild />
        </RuntimeConfigProvider>,
      ),
    ).toThrow(/abort render/u);
    expect(getBrowserRuntimeConfig().apiBaseUrl).toBe('http://localhost:4000');
  });

  it('binds before descendant passive effects issue browser requests', async () => {
    let observed: string | undefined;
    function RequestEffect() {
      useEffect(() => {
        observed = getBrowserRuntimeConfig().apiBaseUrl;
      }, []);
      return null;
    }
    render(
      <RuntimeConfigProvider config={config('https://committed.example.test')}>
        <RequestEffect />
      </RuntimeConfigProvider>,
    );
    await waitFor(() => expect(observed).toBe('https://committed.example.test'));
  });
});
