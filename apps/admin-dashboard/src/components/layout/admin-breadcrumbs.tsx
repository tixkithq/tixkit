'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { routes } from '@/lib/routes';
import { cn } from '@/lib/utils';

export type AdminBreadcrumbItem = {
  label: string;
  href?: string;
};

const eventChildLabels: Record<string, string> = {
  tickets: 'Tickets',
  schedule: 'Schedule',
  products: 'Products',
  attendees: 'Attendees',
  'check-in': 'Check-in',
  messages: 'Messages',
  reports: 'Reports',
  'checkout-form': 'Checkout Form',
  marketing: 'Marketing',
};

const eventContentLabels: Record<string, string> = {
  email: 'Email',
  sms: 'SMS',
  imessage: 'iMessage',
  'social-invite': 'Social Invite',
  'event-page': 'Event Page',
};

const developerLabels: Record<string, string> = {
  'api-keys': 'API Keys',
  webhooks: 'Webhooks',
};

const settingsLabels: Record<string, string> = {
  workspace: 'Workspace',
  branding: 'Branding',
  members: 'Members',
  team: 'Team',
  payments: 'Payments',
  billing: 'Billing',
  profile: 'Profile',
  appearance: 'Appearance',
  organization: 'Organization',
};

function normalizePathname(pathname: string): string {
  const normalized = pathname.split('?')[0]?.split('#')[0] ?? '/';
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

export function getAdminBreadcrumbItems(pathname: string): AdminBreadcrumbItem[] {
  const normalized = normalizePathname(pathname);
  const segments = normalized.split('/').filter(Boolean);

  if (segments[0] === 'events' && segments[1]) {
    const eventId = segments[1];
    const eventHref = routes.eventDetail(eventId);

    if (segments.length === 2) {
      return [{ label: 'Events', href: routes.events }, { label: 'Event' }];
    }

    if (segments[2] === 'content' && segments[3] && eventContentLabels[segments[3]]) {
      return [
        { label: 'Events', href: routes.events },
        { label: 'Event', href: eventHref },
        { label: 'Content' },
        { label: eventContentLabels[segments[3]] },
      ];
    }

    if (segments.length === 3 && eventChildLabels[segments[2]]) {
      return [
        { label: 'Events', href: routes.events },
        { label: 'Event', href: eventHref },
        { label: eventChildLabels[segments[2]] },
      ];
    }
  }

  if (segments[0] === 'orders' && segments.length === 2) {
    return [{ label: 'Orders', href: routes.orders }, { label: 'Order' }];
  }

  if (segments[0] === 'developer' && segments.length === 2 && developerLabels[segments[1]]) {
    return [
      { label: 'Developer', href: routes.developer },
      { label: developerLabels[segments[1]] },
    ];
  }

  if (segments[0] === 'settings' && segments.length === 2 && settingsLabels[segments[1]]) {
    return [{ label: 'Settings', href: routes.settings }, { label: settingsLabels[segments[1]] }];
  }

  return [];
}

export function AdminBreadcrumbs({ className }: { className?: string }) {
  const pathname = usePathname();
  const items = getAdminBreadcrumbItems(pathname);

  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={cn('min-w-0 flex-1', className)}>
      <ol className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1">
              {item.href && !isLast ? (
                <Link
                  href={item.href}
                  prefetch={false}
                  className="truncate rounded-sm font-medium transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={isLast ? 'page' : undefined}
                  className={cn('truncate', isLast && 'font-medium text-foreground')}
                >
                  {item.label}
                </span>
              )}
              {!isLast ? <ChevronRight className="size-4 shrink-0" aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
