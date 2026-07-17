const LOOPBACK_HTTP_HOSTS = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

export function issueApiExplorerRequestUrl(input: {
  allowedOrigins: readonly string[];
  selectedOrigin: string;
  requestPath: string;
}): string {
  if (!input.allowedOrigins.includes(input.selectedOrigin)) {
    throw new Error('The selected sandbox origin is not configured.');
  }
  if (
    containsControlCharacter(input.selectedOrigin) ||
    containsControlCharacter(input.requestPath)
  ) {
    throw new Error('Sandbox request URLs must not contain control characters.');
  }
  if (
    !input.requestPath.startsWith('/') ||
    input.requestPath.startsWith('//') ||
    input.requestPath.includes('\\')
  ) {
    throw new Error('Sandbox request path must remain within the versioned API root.');
  }
  const origin = new URL(input.selectedOrigin);
  if (origin.username || origin.password || origin.origin !== input.selectedOrigin) {
    throw new Error('Sandbox origins must be exact credential-free origins.');
  }
  if (
    origin.protocol !== 'https:' &&
    !(origin.protocol === 'http:' && LOOPBACK_HTTP_HOSTS.has(origin.hostname))
  ) {
    throw new Error('Sandbox origins must use HTTPS, or HTTP on loopback only.');
  }
  const apiRoot = new URL('/v1/', origin);
  const target = new URL(input.requestPath.slice(1), apiRoot);
  if (target.origin !== origin.origin || !target.pathname.startsWith(apiRoot.pathname)) {
    throw new Error('Sandbox request path escapes the versioned API root.');
  }
  return target.toString();
}

export async function executeApiExplorerRequest(
  input: Parameters<typeof issueApiExplorerRequestUrl>[0],
  init: RequestInit,
  request: typeof fetch = globalThis.fetch,
): Promise<Response> {
  return request(issueApiExplorerRequestUrl(input), init);
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}
