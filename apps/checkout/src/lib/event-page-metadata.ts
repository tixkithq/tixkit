import type { Metadata } from 'next';
import type { PublicEventPageBootstrap } from '@/lib/api';
import { resolveEventSocialMedia } from '@/lib/event-media';

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
  const imageUrl =
    storedDiscovery?.socialImageUrl ||
    socialMedia?.url ||
    storedDiscovery?.coverImageUrl ||
    publicDiscovery?.imageUrl ||
    bootstrap.event.coverImageUrl;

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
                ...(socialMedia?.url === imageUrl
                  ? {
                      width: socialMedia.width,
                      height: socialMedia.height,
                      alt: socialMedia.altText,
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
