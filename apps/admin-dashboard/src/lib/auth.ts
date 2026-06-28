/**
 * Clerk is required for authenticated admin API calls. When a usable Clerk
 * publishable key is absent, the shell can render for layout work, but data
 * pages fail closed instead of using runtime fixtures.
 */

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

function isUsableClerkPublishableKey(key: string | undefined): boolean {
  return Boolean(
    key &&
      key !== 'pk_test_' &&
      key !== 'pk_live_' &&
      (key.startsWith('pk_test_') || key.startsWith('pk_live_')),
  );
}

export function authProvider(): string {
  return (
    process.env.NEXT_PUBLIC_AUTH_PROVIDER ??
    process.env.AUTH_PROVIDER ??
    (isUsableClerkPublishableKey(clerkPublishableKey()) ? 'clerk' : undefined) ??
    (process.env.NODE_ENV === 'development' ? 'dev' : 'clerk')
  ).toLowerCase();
}

export function usesLocalDevAuth(): boolean {
  return process.env.NODE_ENV === 'development' && authProvider() === 'dev';
}

export function hasClerkKey(): boolean {
  if (usesLocalDevAuth()) return false;

  return isUsableClerkPublishableKey(clerkPublishableKey());
}

export function clerkPublishableKey(): string | undefined {
  return process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY;
}
