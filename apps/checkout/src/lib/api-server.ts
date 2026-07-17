import type { PublicEvent, PublicEventPageBootstrap } from './api';
import { parseCheckoutServerRuntime } from './runtime-config-server';

type BootstrapResponse = {
  event: PublicEvent;
  contentPage?: PublicEventPageBootstrap['contentPage'];
  availability?: PublicEventPageBootstrap['availability'];
  resaleListings?: PublicEventPageBootstrap['resaleListings'];
};

export function issueCheckoutServerApiUrl(origin: string, path: string): string {
  const hasUnsafeCharacter = [...path].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 32 || codePoint === 127;
  });
  if (
    hasUnsafeCharacter ||
    !path.startsWith('/v1/public/events/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    path.includes('@') ||
    path.includes('#')
  ) {
    throw new Error('The checkout server API path is invalid');
  }
  const base = new URL(origin);
  if (
    (base.protocol !== 'https:' && base.protocol !== 'http:') ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    /%(?:2e|2f|5c)/iu.test(path)
  ) {
    throw new Error('The checkout server API origin or path is invalid');
  }
  const resolved = new URL(path, `${base.origin}/`);
  if (
    resolved.origin !== base.origin ||
    resolved.username ||
    resolved.password ||
    !resolved.pathname.startsWith('/v1/public/events/')
  ) {
    throw new Error('The checkout server API path is invalid');
  }
  return resolved.toString();
}

function normalizeEvent(event: PublicEvent, publicApiOrigin: string): PublicEvent {
  return {
    ...event,
    mediaAssets: event.mediaAssets?.map((asset) => ({
      ...asset,
      renditions: asset.renditions.map((rendition) => ({
        ...rendition,
        url: rendition.url.startsWith('/') ? `${publicApiOrigin}${rendition.url}` : rendition.url,
      })),
    })),
  };
}

async function getBootstrap(path: string): Promise<PublicEventPageBootstrap> {
  const runtime = parseCheckoutServerRuntime();
  const response = await fetch(
    issueCheckoutServerApiUrl(runtime.internalApiBaseUrl, `/v1${path}`),
    {
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      next: { revalidate: 60 },
    },
  );
  if (!response.ok) throw new Error(`Checkout API returned ${response.status}`);
  const value = (await response.json()) as BootstrapResponse;
  if (!value.event || typeof value.event.id !== 'string')
    throw new Error('Checkout API returned an invalid event bootstrap');
  return {
    event: normalizeEvent(value.event, runtime.publicConfig.apiBaseUrl),
    contentPage: value.contentPage ?? null,
    availability: Array.isArray(value.availability) ? value.availability : [],
    resaleListings: value.resaleListings ?? { items: [], nextCursor: null, hasMore: false },
  };
}

export function getServerEventPageBootstrap(eventId: string, locale?: string) {
  const query = new URLSearchParams();
  if (locale) query.set('locale', locale);
  return getBootstrap(
    `/public/events/${encodeURIComponent(eventId)}/page-bootstrap${query.size ? `?${query}` : ''}`,
  );
}

export function getServerEventPageBootstrapBySlug(slug: string, host: string, locale?: string) {
  const query = new URLSearchParams({ host });
  if (locale) query.set('locale', locale);
  return getBootstrap(`/public/events/by-slug/${encodeURIComponent(slug)}/page-bootstrap?${query}`);
}
