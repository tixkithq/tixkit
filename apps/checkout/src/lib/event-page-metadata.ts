import type { Metadata } from 'next';
import type { PublicEventPageBootstrap } from '@/lib/api';
import {
  eventPageMediaReferenceRole,
  isSafeEventPageImageSource,
} from '@tixkit/content-event-page';
import { resolveEventMediaByUrl, resolveEventSocialMedia } from '@/lib/event-media';

export function eventPageMetadataFromBootstrap(bootstrap: PublicEventPageBootstrap): Metadata {
  const storedDiscovery = bootstrap.contentPage?.page.settings?.discovery as
    | {
        seoTitle?: string;
        seoDescription?: string;
        socialImageUrl?: string;
        coverImageUrl?: string;
      }
    | undefined;
  const publicDiscovery = bootstrap.contentPage?.page.discovery;
  const title = storedDiscovery?.seoTitle || publicDiscovery?.title || bootstrap.event.title;
  const description =
    storedDiscovery?.seoDescription ||
    publicDiscovery?.summary ||
    bootstrap.event.description ||
    undefined;
  const socialMedia = resolveEventSocialMedia(bootstrap.event);
  const storedSocialImageUrl =
    isSafeEventPageImageSource(storedDiscovery?.socialImageUrl) &&
    !eventPageMediaReferenceRole(storedDiscovery?.socialImageUrl ?? '')
      ? storedDiscovery.socialImageUrl
      : undefined;
  const storedCoverImageUrl =
    isSafeEventPageImageSource(storedDiscovery?.coverImageUrl) &&
    !eventPageMediaReferenceRole(storedDiscovery?.coverImageUrl ?? '')
      ? storedDiscovery.coverImageUrl
      : undefined;
  const imageUrl =
    storedSocialImageUrl ||
    socialMedia?.url ||
    storedCoverImageUrl ||
    publicDiscovery?.imageUrl ||
    bootstrap.event.coverImageUrl;
  const selectedMedia = imageUrl
    ? (resolveEventMediaByUrl(bootstrap.event, imageUrl) ??
      (socialMedia?.url === imageUrl ? socialMedia : undefined))
    : undefined;

  return {
    title: { absolute: title },
    description,
    openGraph: {
      title,
      description,
      ...(imageUrl
        ? {
            images: [
              {
                url: imageUrl,
                ...(selectedMedia
                  ? {
                      width: selectedMedia.width,
                      height: selectedMedia.height,
                      alt: selectedMedia.altText,
                    }
                  : {}),
              },
            ],
          }
        : {}),
    },
    twitter: {
      card: imageUrl ? 'summary_large_image' : 'summary',
      title,
      description,
      ...(imageUrl ? { images: [imageUrl] } : {}),
    },
  };
}
