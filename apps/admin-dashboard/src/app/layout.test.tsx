import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clerkProviderMock, connectionMock, cookiesMock, headersMock, runtimeConfigMock } =
  vi.hoisted(() => ({
    clerkProviderMock: vi.fn(),
    connectionMock: vi.fn(async () => undefined),
    cookiesMock: vi.fn(),
    headersMock: vi.fn(),
    runtimeConfigMock: vi.fn(),
  }));

vi.mock('@clerk/nextjs', () => ({ ClerkProvider: clerkProviderMock }));
vi.mock('next/headers', () => ({ cookies: cookiesMock, headers: headersMock }));
vi.mock('next/server', () => ({ connection: connectionMock }));
vi.mock('@/lib/runtime-config-server', () => ({ parseAdminRuntimeConfig: runtimeConfigMock }));

import RootLayout from './layout';
import { ThemeProvider } from '@/context/theme-provider';
import { defaultTestRuntimeConfig } from '@/test/runtime-config';

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | undefined {
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (predicate(node)) return node;
  for (const child of Children.toArray(node.props.children as ReactNode)) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return undefined;
}

describe('admin RootLayout CSP nonce integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    headersMock.mockResolvedValue(new Headers({ 'x-nonce': 'request-nonce' }));
    cookiesMock.mockResolvedValue({ get: vi.fn(() => undefined) });
    runtimeConfigMock.mockReturnValue({
      ...defaultTestRuntimeConfig,
      authProvider: 'clerk',
      clerkPublishableKey: 'pk_live_example',
      deploymentProfile: 'production',
    });
  });

  it('enables Clerk dynamic scripts and forwards the request nonce to the theme provider', async () => {
    const tree = await RootLayout({ children: <main>content</main> });
    const clerk = findElement(tree, (element) => element.type === clerkProviderMock);
    const theme = findElement(tree, (element) => element.type === ThemeProvider);

    expect(headersMock).toHaveBeenCalledTimes(1);
    expect(clerk?.props).toMatchObject({ dynamic: true, publishableKey: 'pk_live_example' });
    expect(theme?.props).toMatchObject({ nonce: 'request-nonce' });
  });

  it('nonces the bounded development injector script', async () => {
    runtimeConfigMock.mockReturnValue({
      ...defaultTestRuntimeConfig,
      authProvider: 'dev',
      clerkPublishableKey: undefined,
      deploymentProfile: 'development',
    });
    const tree = await RootLayout({ children: <main>content</main> });
    const injector = findElement(
      tree,
      (element) =>
        element.type === 'script' && element.props.id === 'transitions-refine-injector',
    );
    expect(injector?.props).toMatchObject({ nonce: 'request-nonce' });
  });
});
