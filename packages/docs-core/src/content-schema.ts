export const audiences = ['operator', 'developer', 'self-hoster', 'contributor'] as const;
export type Audience = (typeof audiences)[number];

export const contentTypes = [
  'overview',
  'quickstart',
  'tutorial',
  'how-to',
  'concept',
  'reference',
  'troubleshooting',
  'runbook',
] as const;
export type ContentType = (typeof contentTypes)[number];

export const contentStatuses = [
  'experimental',
  'beta',
  'stable',
  'deprecated',
  'internal',
] as const;
export type ContentStatus = (typeof contentStatuses)[number];

export const productAreas = [
  'platform',
  'workspace',
  'brands',
  'events',
  'inventory',
  'checkout',
  'orders',
  'attendees',
  'check-in',
  'box-office',
  'messaging',
  'reports',
  'team',
  'api',
  'webhooks',
  'sdks',
  'widget',
  'self-hosting',
  'operations',
  'contributing',
] as const;
export type ProductArea = (typeof productAreas)[number];

export interface PublicDocFrontmatter {
  title: string;
  description: string;
  audience: readonly Audience[];
  product_area: ProductArea;
  content_type: ContentType;
  status: Exclude<ContentStatus, 'internal'>;
  owner: string;
  last_verified: string;
  prerequisites: readonly string[];
  related: readonly string[];
  keywords?: readonly string[];
  hidden?: boolean;
}

export function isAudience(value: string): value is Audience {
  return (audiences as readonly string[]).includes(value);
}

export function isContentType(value: string): value is ContentType {
  return (contentTypes as readonly string[]).includes(value);
}

export function isContentStatus(value: string): value is ContentStatus {
  return (contentStatuses as readonly string[]).includes(value);
}

export function isProductArea(value: string): value is ProductArea {
  return (productAreas as readonly string[]).includes(value);
}
