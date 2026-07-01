'use client';

import Link from 'next/link';
import { type ComponentType } from 'react';
import { Building2, CreditCard, ImageIcon, Palette, User, Users, Wallet } from 'lucide-react';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { usePermissions } from '@/context/permission-provider';
import { type TixkitPermission } from '@/lib/permissions';
import { routes } from '@/lib/routes';

const settingsSections: Array<{
  title: string;
  description: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  requiredPermission?: TixkitPermission;
}> = [
  {
    title: 'Workspace',
    description: 'Workspace name, slug, and account-level details.',
    href: routes.settingsWorkspace,
    icon: Building2,
  },
  {
    title: 'Brand',
    description: 'Checkout identity, theme colors, and custom domains.',
    href: routes.settingsBranding,
    icon: ImageIcon,
  },
  {
    title: 'Members',
    description: 'Invite people and manage workspace roles.',
    href: routes.settingsMembers,
    icon: Users,
  },
  {
    title: 'Payments',
    description: 'Payment account setup and brand payment routing.',
    href: routes.settingsPayments,
    icon: Wallet,
    requiredPermission: 'billing.write',
  },
  {
    title: 'Billing',
    description: 'Plan, invoices, and account billing controls.',
    href: routes.settingsBilling,
    icon: CreditCard,
    requiredPermission: 'billing.write',
  },
  {
    title: 'Profile',
    description: 'Signed-in user profile and account settings.',
    href: routes.settingsProfile,
    icon: User,
  },
  {
    title: 'Appearance',
    description: 'Dashboard theme, density, and display preferences.',
    href: routes.settingsAppearance,
    icon: Palette,
  },
];

export default function SettingsPage() {
  const { can } = usePermissions();
  const visibleSettingsSections = settingsSections.filter((section) =>
    can(section.requiredPermission),
  );

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">Settings Home</h2>
        <p className="text-sm text-muted-foreground">Choose the area you want to configure.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {visibleSettingsSections.map((section) => (
          <Link key={section.href} href={section.href} prefetch={false}>
            <Card className="h-full transition-colors hover:bg-accent/40">
              <CardHeader className="flex flex-row items-start gap-3">
                <div className="rounded-md border bg-background p-2">
                  <section.icon className="size-4 text-muted-foreground" />
                </div>
                <div className="space-y-1">
                  <CardTitle className="text-base">{section.title}</CardTitle>
                  <CardDescription>{section.description}</CardDescription>
                </div>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
