'use client';

import { AlertTriangle, Check, ChevronDown, Circle, LockKeyhole } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { ApiErrorState } from '@/components/api-error-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useBootstrap } from '@/context/bootstrap-provider';
import { usePermissions } from '@/context/permission-provider';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { adminApi, type AdminReadinessStep, type AdminWorkspaceReadiness } from '@/lib/api';
import { dashboardDocUrl } from '@/lib/docs';
import { routes } from '@/lib/routes';
import type { TixkitPermission } from '@/lib/permissions';

const collapseStorageKey = 'tixkit-workspace-readiness-collapsed';

const stepLabels: Readonly<Record<string, string>> = {
  workspace_selection: 'Confirm workspace context',
  brand_identity: 'Configure brand identity',
  payment_path: 'Prepare the payment path',
  team_access: 'Review team access',
  legal_configuration: 'Configure legal settings',
  sender_identity: 'Verify sender identity',
};

const reasonLabels: Readonly<Record<string, string>> = {
  workspace_selected: 'Workspace context is selected.',
  organization_inactive: 'The organization is inactive.',
  brand_inactive: 'The selected brand is inactive.',
  brand_identity_configured: 'Brand identity is configured.',
  brand_identity_incomplete: 'Brand identity needs required public details.',
  payment_capture_mode: 'Local capture mode is active; this does not prove provider readiness.',
  payment_capture_mode_paid_unsupported: 'Capture mode cannot prove paid production checkout.',
  payment_path_ready: 'The selected payment path is ready.',
  payment_path_missing: 'Choose and configure a payment path.',
  payment_account_inactive: 'The provider payment account is not active.',
  payment_currency_mismatch: 'Payment-account currency does not match the workspace path.',
  team_access_configured: 'Team access has been reviewed.',
  team_access_single_member: 'Only one workspace member is configured.',
  legal_configuration_complete: 'Legal configuration is complete.',
  legal_configuration_missing: 'Required legal configuration is missing.',
  sender_identity_verified: 'A sender identity is verified.',
  sender_identity_missing: 'No verified sender identity is available.',
  permission_required: 'A workspace owner with the required permission must complete this step.',
};

const actionRoutes: Readonly<Record<string, string>> = {
  select_workspace: routes.settingsWorkspace,
  configure_brand: routes.settingsBranding,
  configure_payments: routes.settingsPayments,
  manage_team: routes.settingsMembers,
  configure_legal: routes.settingsOrganization,
  configure_sender: routes.settingsBranding,
};

export interface WorkspaceReadinessViewModel {
  completeCount: number;
  totalCount: number;
  percent: number;
  nextStep?: AdminReadinessStep;
}

export function workspaceReadinessViewModel(
  readiness: AdminWorkspaceReadiness,
): WorkspaceReadinessViewModel {
  const completeCount = readiness.steps.filter(
    (step) => step.status === 'complete' || step.status === 'not_applicable',
  ).length;
  const nextStep =
    readiness.steps.find(
      (step) =>
        step.priority === 'required' &&
        step.status !== 'complete' &&
        step.status !== 'not_applicable',
    ) ??
    readiness.steps.find((step) => step.status !== 'complete' && step.status !== 'not_applicable');
  return {
    completeCount,
    totalCount: readiness.steps.length,
    percent:
      readiness.steps.length === 0
        ? 100
        : Math.round((completeCount / readiness.steps.length) * 100),
    ...(nextStep ? { nextStep } : {}),
  };
}

function ReadinessStepRow({ step }: { step: AdminReadinessStep }) {
  const { can } = usePermissions();
  const action = step.actionId ? actionRoutes[step.actionId] : undefined;
  const permitted = step.requiredPermission
    ? can(step.requiredPermission as TixkitPermission)
    : true;
  const Icon =
    step.status === 'complete' || step.status === 'not_applicable'
      ? Check
      : step.status === 'blocked'
        ? LockKeyhole
        : Circle;
  return (
    <li className="flex flex-wrap items-start gap-3 border-t py-3 first:border-t-0">
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${step.status === 'blocked' ? 'text-destructive' : 'text-muted-foreground'}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{stepLabels[step.id] ?? step.id.replaceAll('_', ' ')}</p>
        <p className="text-xs text-muted-foreground">
          {step.reasonCodes
            .map((code) => reasonLabels[code] ?? code.replaceAll('_', ' '))
            .join(' ')}
        </p>
      </div>
      {action && permitted && step.status !== 'complete' && step.status !== 'not_applicable' ? (
        <Button variant="outline" size="sm" asChild>
          <Link href={action}>Resolve</Link>
        </Button>
      ) : null}
      {action && !permitted && step.status !== 'complete' ? (
        <span className="text-xs text-muted-foreground">Owner action required</span>
      ) : null}
    </li>
  );
}

function ScopedWorkspaceReadiness({
  organizationId,
  brandId,
}: {
  organizationId: string;
  brandId: string;
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  const { data, loading, error, refetch } = useAdminQuery(
    ['getWorkspaceReadiness', organizationId, brandId],
    () => adminApi.getWorkspaceReadiness(organizationId, brandId),
  );

  React.useEffect(() => {
    setCollapsed(window.localStorage.getItem(collapseStorageKey) === 'true');
  }, []);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(collapseStorageKey, String(next));
      return next;
    });
  }

  if (loading) return <Skeleton className="h-40 w-full" />;
  if (error) return <ApiErrorState error={error} onRetry={refetch} />;
  if (!data) return null;
  const view = workspaceReadinessViewModel(data);

  if (data.complete) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Check className="size-4 text-emerald-600" aria-hidden="true" />
            Workspace setup complete
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Continue monitoring event, payment, webhook, inventory, export, and check-in readiness.
          </p>
          <div className="flex gap-3">
            <Link className="text-sm font-medium text-primary" href={routes.events}>
              View events
            </Link>
            <a
              className="text-sm font-medium text-primary"
              href={dashboardDocUrl('platformOverview')}
            >
              Read operations guide
            </a>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Finish workspace setup</CardTitle>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
          >
            {' '}
            {collapsed ? 'Expand' : 'Collapse'}{' '}
            <ChevronDown
              className={`size-4 transition-transform ${collapsed ? '' : 'rotate-180'}`}
              aria-hidden="true"
            />
          </Button>
        </div>
        <div>
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span>
              {view.completeCount} of {view.totalCount} steps ready
            </span>
            <span>{view.percent}%</span>
          </div>
          <progress
            className="h-2 w-full overflow-hidden rounded-full accent-primary"
            value={view.percent}
            max={100}
            aria-label="Workspace readiness progress"
          >
            {view.percent}%
          </progress>
        </div>
      </CardHeader>
      {!collapsed ? (
        <CardContent>
          {view.nextStep?.status === 'blocked' ? (
            <p className="mb-3 flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="size-4" aria-hidden="true" />
              The next required step is blocked. Resolve its permission or provider prerequisite.
            </p>
          ) : null}
          <ul>
            {data.steps.map((step) => (
              <ReadinessStepRow key={step.id} step={step} />
            ))}
          </ul>
          <a
            className="mt-3 inline-block text-sm font-medium text-primary"
            href={dashboardDocUrl('localQuickstart')}
          >
            Open setup guide
          </a>
        </CardContent>
      ) : null}
    </Card>
  );
}

export function WorkspaceReadinessChecklist() {
  const { organizationId, brandId, loading } = useBootstrap();
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (!organizationId || !brandId)
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Select a workspace and brand</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Readiness is scoped to an explicit organization and brand. Select both before continuing
            setup.
          </p>
        </CardContent>
      </Card>
    );
  return <ScopedWorkspaceReadiness organizationId={organizationId} brandId={brandId} />;
}
