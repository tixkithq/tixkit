'use client';

import { createContext, useContext } from 'react';
import type { PublicAdminRuntimeConfig } from '@/lib/runtime-config-contract';
import { initializeBrowserRuntimeConfig } from '@/lib/runtime-config-browser';

const isolatedTestConfig: PublicAdminRuntimeConfig | null =
  process.env.NODE_ENV === 'test'
    ? {
        schemaVersion: '1',
        deploymentProfile: 'test',
        apiBaseUrl: 'http://localhost:4000',
        platformApiBaseUrl: 'http://localhost:4000/v1',
        checkoutUrl: 'http://localhost:3000',
        docsUrl: 'http://localhost:3002',
        uploadOrigin: 'http://localhost:9000',
        authProvider: 'dev',
        buildRevision: 'test',
        configFingerprint: `sha256:${'0'.repeat(64)}`,
      }
    : null;

const RuntimeConfigContext = createContext<PublicAdminRuntimeConfig | null>(isolatedTestConfig);

export function RuntimeConfigProvider({
  config,
  children,
}: {
  config: PublicAdminRuntimeConfig;
  children?: React.ReactNode;
}) {
  if (process.env.NODE_ENV !== 'test') initializeBrowserRuntimeConfig(config);
  return <RuntimeConfigContext value={config}>{children}</RuntimeConfigContext>;
}

export function useRuntimeConfig(): PublicAdminRuntimeConfig {
  const config = useContext(RuntimeConfigContext);
  if (!config) throw new Error('useRuntimeConfig must be used within RuntimeConfigProvider');
  return config;
}
