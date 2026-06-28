export function normalizeHost(value: string | undefined): string {
  const host = value?.trim();
  if (!host) return '';
  if (host.includes('://') || /[\s,/?#]/.test(host)) return '';
  try {
    const url = new URL(`https://${host}`);
    if (url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return '';
    }
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function configuredSharedCheckoutHost(): string {
  const configured =
    process.env.NEXT_PUBLIC_CHECKOUT_URL ??
    process.env.CHECKOUT_URL ??
    'https://checkout.tixkit.com';
  try {
    const url = configured.includes('://') ? new URL(configured) : new URL(`https://${configured}`);
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return 'checkout.tixkit.com';
  }
}

export function isSharedCheckoutHost(host: string | undefined): boolean {
  const normalized = normalizeHost(host);
  if (!normalized) return true;
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1') {
    return true;
  }
  return normalized === configuredSharedCheckoutHost();
}

export function publicHostHeader(headers: Headers): string {
  const host = normalizeHost(headers.get('host') ?? undefined);
  const forwardedHost = normalizeHost(headers.get('x-forwarded-host') ?? undefined);

  if (host && isSharedCheckoutHost(host) && forwardedHost && !isSharedCheckoutHost(forwardedHost)) {
    return forwardedHost;
  }

  return host;
}
