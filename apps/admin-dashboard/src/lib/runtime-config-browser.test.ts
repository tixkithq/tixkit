import { afterEach, describe, expect, it } from 'vitest';
import { defaultTestRuntimeConfig } from '@/test/runtime-config';
import {
  getBrowserRuntimeConfig,
  initializeBrowserRuntimeConfig,
  resetBrowserRuntimeConfigForTests,
} from './runtime-config-browser';

describe('immutable browser runtime binding', () => {
  afterEach(() => resetBrowserRuntimeConfigForTests());

  it('copies and freezes the provider snapshot instead of retaining its object', () => {
    resetBrowserRuntimeConfigForTests();
    const input = { ...defaultTestRuntimeConfig };
    initializeBrowserRuntimeConfig(input);
    input.apiBaseUrl = 'https://attacker.example';
    expect(getBrowserRuntimeConfig().apiBaseUrl).toBe('http://localhost:4000');
    expect(Object.isFrozen(getBrowserRuntimeConfig())).toBe(true);
  });

  it('rejects a forged same-fingerprint rebind that changes any public field', () => {
    resetBrowserRuntimeConfigForTests();
    initializeBrowserRuntimeConfig(defaultTestRuntimeConfig);
    expect(() =>
      initializeBrowserRuntimeConfig({
        ...defaultTestRuntimeConfig,
        uploadOrigin: 'https://attacker.example',
      }),
    ).toThrow('cannot change within a browser document');
    expect(getBrowserRuntimeConfig().uploadOrigin).toBe('http://localhost:9000');
  });
});
