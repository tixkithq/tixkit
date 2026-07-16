import type { AdminBrand, AdminEventDetail, AdminEventListItem } from '@/lib/api';
import type { PublicAdminRuntimeConfig } from './runtime-config-contract';

function checkoutBaseUrl(config: PublicAdminRuntimeConfig): string {
  return config.checkoutUrl;
}

function activePrimaryDomain(brand: AdminBrand | undefined): string | undefined {
  if (!brand?.whiteLabel) return undefined;
  const domain =
    brand?.domains.find(
      (item) => item.isPrimary && item.isVerified && item.sslStatus === 'active',
    ) ?? brand?.domains.find((item) => item.isVerified && item.sslStatus === 'active');
  return domain?.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

export function publicEventUrl(
  event: Pick<AdminEventListItem | AdminEventDetail, 'id' | 'slug'> & { brandId?: string },
  brands: AdminBrand[] = [],
  config: PublicAdminRuntimeConfig,
): string {
  const brand = event.brandId ? brands.find((item) => item.id === event.brandId) : undefined;
  const domain = activePrimaryDomain(brand);
  if (domain && event.slug) return `https://${domain}/${event.slug}`;
  return `${checkoutBaseUrl(config)}/e/${event.id}`;
}
