import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTestRuntimeConfig } from '@/test/runtime-config';
import { readAdminRuntimeConfig } from './runtime-config-contract';
import { getAdminApiAuthHeaders } from './api';
import { authProvider, usesLocalDevAuth } from './auth';
import {
  initializeBrowserRuntimeConfig,
  resetBrowserRuntimeConfigForTests,
} from './runtime-config-browser';

describe('provider-owned admin authentication', () => {
  beforeEach(() => {
    delete window.Clerk;
  });
  afterEach(() => {
    delete window.Clerk;
  });

  it('does not poll Clerk in bounded dev authentication', async () => {
    installTestRuntimeConfig({ authProvider: 'dev', clerkPublishableKey: undefined });
    const config = readAdminRuntimeConfig();
    expect(authProvider(config)).toBe('dev');
    expect(usesLocalDevAuth(config)).toBe(true);
    await expect(getAdminApiAuthHeaders({ 'X-Test': '1' })).resolves.toEqual({ 'X-Test': '1' });
  });

  it('attaches the active Clerk token when the snapshot enables Clerk', async () => {
    resetBrowserRuntimeConfigForTests();
    initializeBrowserRuntimeConfig(
      installTestRuntimeConfig({
        authProvider: 'clerk',
        clerkPublishableKey: 'pk_test_example',
      }),
    );
    const getToken = vi.fn().mockResolvedValue('clerk_session_jwt');
    window.Clerk = { loaded: true, session: { getToken } };
    await expect(getAdminApiAuthHeaders()).resolves.toMatchObject({
      Authorization: 'Bearer clerk_session_jwt',
    });
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicit authorization header without asking Clerk', async () => {
    resetBrowserRuntimeConfigForTests();
    initializeBrowserRuntimeConfig(
      installTestRuntimeConfig({
        authProvider: 'clerk',
        clerkPublishableKey: 'pk_test_example',
      }),
    );
    const getToken = vi.fn().mockResolvedValue('unused');
    window.Clerk = { loaded: true, session: { getToken } };
    await expect(
      getAdminApiAuthHeaders({ Authorization: 'Bearer supplied_token' }),
    ).resolves.toMatchObject({ Authorization: 'Bearer supplied_token' });
    expect(getToken).not.toHaveBeenCalled();
  });

  it('ignores a substituted incomplete diagnostic auth snapshot', async () => {
    installTestRuntimeConfig({ authProvider: 'clerk', clerkPublishableKey: undefined });
    expect(() => authProvider(readAdminRuntimeConfig())).toThrow(
      'Clerk configuration is incomplete',
    );
    await expect(getAdminApiAuthHeaders()).resolves.toEqual({});
  });
});
