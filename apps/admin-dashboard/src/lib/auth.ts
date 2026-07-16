import type { PublicAdminRuntimeConfig } from './runtime-config-contract';

export type AdminUser = {
  name: string;
  email: string;
  imageUrl: string | null;
};

export const LOCAL_DEV_USER: AdminUser = {
  name: 'Local Organizer',
  email: 'organizer@localhost',
  imageUrl: null,
};

export function authProvider(config: PublicAdminRuntimeConfig): 'clerk' | 'dev' {
  return config.authProvider;
}

export function usesLocalDevAuth(config: PublicAdminRuntimeConfig): boolean {
  return authProvider(config) === 'dev';
}

export function hasClerkKey(config: PublicAdminRuntimeConfig): boolean {
  return config.authProvider === 'clerk' && Boolean(config.clerkPublishableKey);
}

export function clerkPublishableKey(config: PublicAdminRuntimeConfig): string | undefined {
  return config.clerkPublishableKey;
}
