const LOOPBACK_HTTP_HOSTS = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

export function issueCheckoutHeadlessRequestUrl(apiBaseUrl: string, path: string): string {
  if (containsControlCharacter(apiBaseUrl) || containsControlCharacter(path)) {
    throw new Error('Checkout API URLs must not contain control characters.');
  }
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error('Checkout API paths must be root-relative within the configured API base.');
  }

  let base: URL;
  try {
    base = new URL(apiBaseUrl);
  } catch {
    throw new Error('Checkout API base URL must be absolute.');
  }
  if (base.username || base.password) {
    throw new Error('Checkout API base URL must not contain credentials.');
  }
  if (
    base.protocol !== 'https:' &&
    !(base.protocol === 'http:' && LOOPBACK_HTTP_HOSTS.has(base.hostname))
  ) {
    throw new Error('Checkout API base URL must use HTTPS, or HTTP on loopback only.');
  }
  if (base.search || base.hash) {
    throw new Error('Checkout API base URL must not contain a query or fragment.');
  }

  base.pathname = `${base.pathname.replace(/\/+$/u, '')}/`;
  const basePath = base.pathname;
  const target = new URL(path.slice(1), base);
  if (target.origin !== base.origin || !target.pathname.startsWith(basePath)) {
    throw new Error('Checkout API path escapes the configured API base.');
  }
  return target.toString();
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}
