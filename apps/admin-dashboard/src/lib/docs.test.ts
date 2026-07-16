import { describe, expect, it } from 'vitest';
import { installTestRuntimeConfig } from '@/test/runtime-config';
import { dashboardDocUrl } from './docs';

describe('dashboardDocUrl', () => {
  it('resolves the URL from the current document snapshot at call time', () => {
    expect(dashboardDocUrl('apiReference', installTestRuntimeConfig())).toBe(
      'http://localhost:3002/reference/api',
    );
    const config = installTestRuntimeConfig({ docsUrl: 'https://docs.example.test' });
    expect(dashboardDocUrl('webhookEvents', config)).toBe(
      'https://docs.example.test/reference/webhook-events',
    );
  });

  it('uses a same-origin path when the optional docs origin is omitted', () => {
    const config = installTestRuntimeConfig();
    document.documentElement.removeAttribute('data-tixkit-docs-url');
    expect(config.docsUrl).toBeDefined();
    expect(dashboardDocUrl('apiReference', { ...config, docsUrl: undefined })).toBe(
      '/reference/api',
    );
  });
});
