import { ExternalLinkIcon } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import type { ResolvedBrand } from '@/lib/brand';

/**
 * Legal / support / refund link area rendered on every buyer-facing surface.
 *
 * Links only appear when the brand actually exposes them. When the brand is
 * the platform fallback, no legal links are rendered (we do not fabricate
 * policies that the organizer has not set).
 */
export function BrandFooter({ brand }: { brand: ResolvedBrand }) {
  const links: Array<{ label: string; href: string }> = [];
  if (brand.legalUrls.terms) links.push({ label: 'Terms', href: brand.legalUrls.terms });
  if (brand.legalUrls.privacy) links.push({ label: 'Privacy', href: brand.legalUrls.privacy });
  if (brand.legalUrls.refundPolicy)
    links.push({ label: 'Refund policy', href: brand.legalUrls.refundPolicy });
  if (brand.supportUrl) links.push({ label: 'Support', href: brand.supportUrl });

  return (
    <footer className="space-y-4 pt-4">
      <Separator />
      <div className="flex flex-col items-start justify-between gap-3 text-xs text-muted-foreground sm:flex-row sm:items-center">
        {brand.whiteLabel ? (
          <p>{brand.name}</p>
        ) : (
          <p>{brand.fallback ? 'Powered by Tixkit' : `${brand.name} · Powered by Tixkit`}</p>
        )}
        {links.length > 0 ? (
          <nav className="flex flex-wrap gap-x-4 gap-y-1.5">
            {links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
              >
                {link.label}
                <ExternalLinkIcon className="size-3" />
              </a>
            ))}
          </nav>
        ) : null}
      </div>
    </footer>
  );
}
