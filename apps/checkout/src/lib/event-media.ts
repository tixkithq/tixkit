import type { PublicEvent, PublicEventMediaAsset } from './api';

export type ResolvedEventMedia = {
  url: string;
  altText: string;
  width: number;
  height: number;
};

type Candidate = readonly [
  role: PublicEventMediaAsset['role'],
  variant: PublicEventMediaAsset['renditions'][number]['variant'],
];

const PAGE_CANDIDATES: readonly Candidate[] = [
  ['cover', 'page'],
  ['poster', 'page'],
  ['cover', 'social'],
  ['poster', 'social'],
  ['social', 'page'],
  ['social', 'social'],
  ['cover', 'card'],
  ['poster', 'card'],
  ['social', 'card'],
  ['cover', 'thumbnail'],
  ['poster', 'thumbnail'],
  ['social', 'thumbnail'],
];

const SOCIAL_CANDIDATES: readonly Candidate[] = [
  ['social', 'social'],
  ['cover', 'social'],
  ['poster', 'social'],
  ['social', 'page'],
  ['cover', 'page'],
  ['poster', 'page'],
  ['social', 'card'],
  ['cover', 'card'],
  ['poster', 'card'],
  ['social', 'thumbnail'],
  ['cover', 'thumbnail'],
  ['poster', 'thumbnail'],
];

function resolve(
  assets: PublicEvent['mediaAssets'],
  candidates: readonly Candidate[],
): ResolvedEventMedia | undefined {
  for (const [role, variant] of candidates) {
    const asset = assets?.find((candidate) => candidate.role === role);
    const rendition = asset?.renditions.find((candidate) => candidate.variant === variant);
    if (asset && rendition)
      return {
        url: rendition.url,
        altText: asset.altText,
        width: rendition.width,
        height: rendition.height,
      };
  }
  return undefined;
}

export function resolveEventPageMedia(event: PublicEvent): ResolvedEventMedia | undefined {
  return resolve(event.mediaAssets, PAGE_CANDIDATES);
}

export function resolveEventSocialMedia(event: PublicEvent): ResolvedEventMedia | undefined {
  return resolve(event.mediaAssets, SOCIAL_CANDIDATES);
}

export function resolveEventMediaRole(
  event: PublicEvent,
  role: PublicEventMediaAsset['role'],
  variant: PublicEventMediaAsset['renditions'][number]['variant'],
): ResolvedEventMedia | undefined {
  const asset = event.mediaAssets?.find((candidate) => candidate.role === role);
  const rendition = asset?.renditions.find((candidate) => candidate.variant === variant);
  return asset && rendition
    ? {
        url: rendition.url,
        altText: asset.altText,
        width: rendition.width,
        height: rendition.height,
      }
    : undefined;
}

export function resolveEventMediaByUrl(
  event: PublicEvent,
  url: string,
  apiOrigin: string,
): ResolvedEventMedia | undefined {
  const expectedOrigin = new URL(apiOrigin).origin;
  const ownedPath = ownedEventMediaRenditionPath(url, {
    requireRelative: true,
    expectedOrigin,
  });
  for (const asset of event.mediaAssets ?? []) {
    const rendition = asset.renditions.find(
      (candidate) =>
        candidate.url === url ||
        (ownedPath !== undefined &&
          ownedEventMediaRenditionPath(candidate.url, {
            requireRelative: false,
            expectedOrigin,
          }) === ownedPath),
    );
    if (rendition)
      return {
        url: rendition.url,
        altText: asset.altText,
        width: rendition.width,
        height: rendition.height,
      };
  }
  return undefined;
}

const OWNED_EVENT_MEDIA_RENDITION_PATH = /^\/v1\/public\/event-media\/renditions\/[A-Za-z0-9_-]+$/u;

function ownedEventMediaRenditionPath(
  url: string,
  input: { requireRelative: boolean; expectedOrigin: string },
): string | undefined {
  const relative = url.startsWith('/') && !url.startsWith('//');
  if (input.requireRelative && !relative) return undefined;
  try {
    const parsed = new URL(url, `${input.expectedOrigin}/`);
    if (
      parsed.origin !== input.expectedOrigin ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !OWNED_EVENT_MEDIA_RENDITION_PATH.test(parsed.pathname)
    )
      return undefined;
    return parsed.pathname;
  } catch {
    return undefined;
  }
}
