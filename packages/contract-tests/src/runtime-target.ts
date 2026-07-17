const LOOPBACK_HTTP_HOSTS = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

export function issueContractTestRequestUrl(baseUrl: string, path: string): string {
  if (containsControlCharacter(baseUrl) || containsControlCharacter(path)) {
    throw new Error('Contract-test request URLs must not contain control characters.');
  }
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error('Contract-test request paths must remain within the implementation origin.');
  }
  const origin = new URL(baseUrl);
  if (origin.username || origin.password || origin.origin !== baseUrl) {
    throw new Error('Contract-test baseUrl must be an exact credential-free origin.');
  }
  if (
    origin.protocol !== 'https:' &&
    !(origin.protocol === 'http:' && LOOPBACK_HTTP_HOSTS.has(origin.hostname))
  ) {
    throw new Error('Contract-test baseUrl must use HTTPS, or HTTP on loopback only.');
  }
  const target = new URL(path.slice(1), `${origin.origin}/`);
  if (target.origin !== origin.origin) {
    throw new Error('Contract-test request path escapes the implementation origin.');
  }
  return target.toString();
}

export async function executeContractTestRequest(
  baseUrl: string,
  path: string,
  init: RequestInit,
  request: typeof fetch = globalThis.fetch,
): Promise<Response> {
  return request(issueContractTestRequestUrl(baseUrl, path), init);
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}
