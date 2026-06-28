'use client';

import * as React from 'react';
import Link from 'next/link';
import { ShieldAlertIcon } from 'lucide-react';
import { usePermissions } from '@/context/permission-provider';
import { type TixkitPermission } from '@/lib/permissions';
import { routes } from '@/lib/routes';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

type PermissionGuardProps = {
  /** Permission required to view the guarded route content. */
  required: TixkitPermission;
  children: React.ReactNode;
};

/**
 * Gates route content behind a permission check from the permission provider.
 *
 * While permissions are still loading (production principal fetch), a skeleton
 * is rendered so an authorized user never sees a spurious "access denied"
 * flash. Once resolved, unauthorized users are shown an access-denied view
 * (and bounced back to the dashboard) instead of the protected content. This
 * prevents manual navigation to routes the user lacks permissions for.
 */
export function PermissionGuard({ required, children }: PermissionGuardProps) {
  const { can, loading } = usePermissions();
  const allowed = can(required);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!allowed) {
    return <AccessDenied />;
  }

  return <>{children}</>;
}

function AccessDenied() {
  return (
    <div className="mx-auto max-w-lg py-16">
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-destructive/10">
            <ShieldAlertIcon className="size-8 text-destructive" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Access denied</h1>
          <p className="text-sm text-muted-foreground">
            You do not have permission to view this page. Contact an administrator if you believe
            this is an error.
          </p>
          <Button asChild variant="outline" className="mt-2">
            <Link href={routes.dashboard} prefetch={false}>
              Back to dashboard
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
