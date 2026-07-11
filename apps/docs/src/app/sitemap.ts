import type { MetadataRoute } from 'next';
import { contentManifest } from '@/generated/content-manifest';
import { docsSiteConfig } from '@/lib/site';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  const { siteUrl } = docsSiteConfig();
  return ['/', ...Object.keys(contentManifest)].map((route) => ({
    url: `${siteUrl}${route === '/' ? '' : route}`,
    changeFrequency: route.startsWith('/reference/') ? 'weekly' : 'monthly',
    priority: route === '/' ? 1 : 0.7,
  }));
}
