'use client';

import { type ComponentType, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { User, Building2, Palette, Users, CreditCard, Wallet, ImageIcon } from 'lucide-react';
import { routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/context/permission-provider';
import { type TixkitPermission } from '@/lib/permissions';

const settingsNav: Array<{
  title: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  requiredPermission?: TixkitPermission;
}> = [
  {
    title: 'Workspace',
    href: routes.settingsWorkspace,
    icon: Building2,
    requiredPermission: 'settings.write',
  },
  {
    title: 'Brand',
    href: routes.settingsBranding,
    icon: ImageIcon,
    requiredPermission: 'settings.write',
  },
  {
    title: 'Members',
    href: routes.settingsMembers,
    icon: Users,
    requiredPermission: 'settings.write',
  },
  {
    title: 'Payments',
    href: routes.settingsPayments,
    icon: Wallet,
    requiredPermission: 'billing.write',
  },
  {
    title: 'Billing',
    href: routes.settingsBilling,
    icon: CreditCard,
    requiredPermission: 'billing.write',
  },
  { title: 'Profile', href: routes.settingsProfile, icon: User },
  { title: 'Appearance', href: routes.settingsAppearance, icon: Palette },
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { can } = usePermissions();
  const visibleSettingsNav = settingsNav.filter((item) => can(item.requiredPermission));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your account, workspace, and platform configuration
        </p>
      </div>
      <div className="flex flex-col gap-8 lg:flex-row">
        <nav className="lg:w-56 lg:shrink-0">
          <ul className="flex flex-row flex-wrap gap-1 lg:flex-col">
            {visibleSettingsNav.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    prefetch={false}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-foreground',
                      isActive ? 'bg-accent text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <item.icon className="size-4" />
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
