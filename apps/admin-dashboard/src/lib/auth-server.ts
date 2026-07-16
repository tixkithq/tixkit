import { parseAdminRuntimeConfig } from './runtime-config-server';

export function usesLocalDevAuth(): boolean {
  try {
    return parseAdminRuntimeConfig().authProvider === 'dev';
  } catch {
    return false;
  }
}

export function hasClerkKey(): boolean {
  try {
    const config = parseAdminRuntimeConfig();
    return config.authProvider === 'clerk' && Boolean(config.clerkPublishableKey);
  } catch {
    return false;
  }
}
