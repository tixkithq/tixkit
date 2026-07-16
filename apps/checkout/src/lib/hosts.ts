export function normalizeHost(value: string | undefined): string {
  const host = value?.trim();
  if (!host) return '';
  if (host.includes('://') || /[\s,/?#]/.test(host)) return '';
  try {
    const url = new URL(`https://${host}`);
    if (
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return '';
    }
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function configuredSharedCheckoutHost(checkoutUrl?: string): string {
  const configured = checkoutUrl ?? 'https://checkout.tixkit.com';
  try {
    const url = configured.includes('://') ? new URL(configured) : new URL(`https://${configured}`);
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return 'checkout.tixkit.com';
  }
}

export function isSharedCheckoutHost(host: string | undefined, checkoutUrl?: string): boolean {
  const normalized = normalizeHost(host);
  if (!normalized) return true;
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1') {
    return true;
  }
  return normalized === configuredSharedCheckoutHost(checkoutUrl);
}

export function publicHostHeader(headers: Headers, checkoutUrl?: string): string {
  const host = normalizeHost(headers.get('host') ?? undefined);
  const forwardedHost = normalizeHost(headers.get('x-forwarded-host') ?? undefined);

  if (
    host &&
    isSharedCheckoutHost(host, checkoutUrl) &&
    forwardedHost &&
    !isSharedCheckoutHost(forwardedHost, checkoutUrl)
  ) {
    return forwardedHost;
  }

  return host;
}
