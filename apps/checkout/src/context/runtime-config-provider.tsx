'use client';

import { createContext, useContext, useInsertionEffect } from 'react';
import { initializeBrowserRuntimeConfig } from '@/lib/runtime-config-browser';
import type { PublicCheckoutRuntimeConfig } from '@/lib/runtime-config-contract';

const isolatedTestConfig: PublicCheckoutRuntimeConfig | null =
  process.env.NODE_ENV === 'test'
    ? {
        schemaVersion: '1',
        deploymentProfile: 'test',
        apiBaseUrl: 'http://localhost:4000',
        platformApiBaseUrl: 'http://localhost:4000/v1',
        checkoutUrl: 'https://checkout.tixkit.com',
        mediaOrigin: 'http://localhost:9000',
        buildRevision: 'test',
        configFingerprint: `sha256:${'0'.repeat(64)}`,
      }
    : null;

const RuntimeConfigContext = createContext<PublicCheckoutRuntimeConfig | null>(isolatedTestConfig);

export function RuntimeConfigProvider({
  config,
  children,
}: {
  config: PublicCheckoutRuntimeConfig;
  children: React.ReactNode;
}) {
  useInsertionEffect(() => {
    initializeBrowserRuntimeConfig(config);
  }, [config]);
  return <RuntimeConfigContext value={config}>{children}</RuntimeConfigContext>;
}

export function useRuntimeConfig(): PublicCheckoutRuntimeConfig {
  const config = useContext(RuntimeConfigContext);
  if (!config) throw new Error('useRuntimeConfig must be used within RuntimeConfigProvider');
  return config;
}
