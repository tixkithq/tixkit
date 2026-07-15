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
