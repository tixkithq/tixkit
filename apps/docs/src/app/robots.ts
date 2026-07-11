import type { MetadataRoute } from 'next';
import { docsSiteConfig } from '@/lib/site';

export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  const { siteUrl } = docsSiteConfig();
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/preview/'] },
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
