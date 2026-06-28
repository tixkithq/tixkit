import type { AdminBrand, AdminEventDetail, AdminEventListItem } from '@/lib/api';

function checkoutBaseUrl(): string {
  const configured =
    process.env.NEXT_PUBLIC_CHECKOUT_URL ?? process.env.NEXT_PUBLIC_TIXKIT_CHECKOUT_URL;
  if (configured?.trim()) return configured.trim().replace(/\/+$/, '');
  return process.env.NODE_ENV === 'production'
    ? 'https://checkout.tixkit.com'
    : 'http://localhost:3000';
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
): string {
  const brand = event.brandId ? brands.find((item) => item.id === event.brandId) : undefined;
  const domain = activePrimaryDomain(brand);
  if (domain && event.slug) return `https://${domain}/${event.slug}`;
  return `${checkoutBaseUrl()}/e/${event.id}`;
}
