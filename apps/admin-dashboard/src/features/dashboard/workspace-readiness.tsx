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
import {
  adminApi,
  type AdminReadinessStep,
  type AdminWorkspaceDashboardAction,
  type AdminWorkspaceReadiness,
} from '@/lib/api';
import { useDashboardDocUrl } from '@/lib/docs';
import { routes } from '@/lib/routes';
import type { TixkitPermission } from '@/lib/permissions';

export const workspaceReadinessCollapseStorageKey = (organizationId: string, brandId: string) =>
  `tixkit-workspace-readiness-collapsed:${organizationId}:${brandId}`;

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

const actionRoutes: Readonly<Partial<Record<string, string>>> = {
  select_workspace: routes.settingsWorkspace,
  configure_brand: routes.settingsBranding,
  configure_payments: routes.settingsPayments,
  manage_team: routes.settingsMembers,
  configure_legal: routes.settingsBranding,
};

export function workspaceActionRoute(actionId: string | null): string | undefined {
  return actionId ? actionRoutes[actionId] : undefined;
}

const ownerLabels: Readonly<Record<AdminWorkspaceDashboardAction['owner'], string>> = {
  organizer: 'Organizer',
  finance: 'Finance',
  marketing: 'Marketing',
  support: 'Support',
  door_operations: 'Door operations',
};

const severityLabels: Readonly<Record<AdminWorkspaceDashboardAction['severity'], string>> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
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

function WorkspaceActionRow({ action: item }: { action: AdminWorkspaceDashboardAction }) {
  const { can } = usePermissions();
  const actionRoute = workspaceActionRoute(item.actionId);
  const permitted = item.requiredPermission
    ? can(item.requiredPermission as TixkitPermission)
    : true;
  const Icon = item.status === 'blocked' ? LockKeyhole : Circle;
  const label = stepLabels[item.stepId] ?? 'Workspace readiness step';
  return (
    <li className="flex flex-wrap items-start gap-3 border-t py-3 first:border-t-0">
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${item.status === 'blocked' ? 'text-destructive' : 'text-muted-foreground'}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs font-medium text-foreground/80">
          {severityLabels[item.severity]} · Owner: {ownerLabels[item.owner]} ·{' '}
          {item.deadlineAt ? (
            <>
              Due{' '}
              <time dateTime={item.deadlineAt}>{new Date(item.deadlineAt).toLocaleString()}</time>
            </>
          ) : (
            'No fixed deadline'
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {item.reasonCodes
            .map((code) => reasonLabels[code] ?? 'Review this workspace setting before continuing.')
            .join(' ')}
        </p>
      </div>
      {actionRoute && permitted ? (
        <Button variant="outline" size="sm" asChild>
          <Link href={actionRoute} aria-label={`Resolve ${label}`}>
            Resolve
          </Link>
        </Button>
      ) : null}
      {!actionRoute || !permitted ? (
        <span className="text-xs text-muted-foreground">
          {ownerLabels[item.owner]} action required
        </span>
      ) : null}
    </li>
  );
}

const statusLabels: Readonly<Record<AdminReadinessStep['status'], string>> = {
  complete: 'Complete',
  incomplete: 'Needs attention',
  blocked: 'Blocked',
  not_applicable: 'Not applicable',
};

function WorkspaceReadinessDetail({ step }: { step: AdminReadinessStep }) {
  const label = stepLabels[step.id] ?? 'Workspace readiness step';
  return (
    <li className="border-t py-3 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{label}</p>
        <span className="text-xs font-medium text-foreground/80">{statusLabels[step.status]}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {step.reasonCodes.length > 0
          ? step.reasonCodes
              .map(
                (code) =>
                  reasonLabels[code] ?? 'Review this workspace setting before continuing.',
              )
              .join(' ')
          : 'No additional action is required for this step.'}
      </p>
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
  const docUrl = useDashboardDocUrl();
  const [collapsed, setCollapsed] = React.useState(false);
  const { data, loading, error, refetch } = useAdminQuery(
    ['getWorkspaceReadiness', organizationId, brandId],
    () => adminApi.getWorkspaceReadiness(organizationId, brandId),
  );

  React.useEffect(() => {
    const saved = window.localStorage.getItem(
      workspaceReadinessCollapseStorageKey(organizationId, brandId),
    );
    setCollapsed(saved === null ? Boolean(data?.complete) : saved === 'true');
  }, [brandId, data?.complete, organizationId]);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(
        workspaceReadinessCollapseStorageKey(organizationId, brandId),
        String(next),
      );
      return next;
    });
  }

  if (loading) return <Skeleton className="h-40 w-full" />;
  if (error) return <ApiErrorState error={error} onRetry={refetch} />;
  if (!data) return null;
  const view = workspaceReadinessViewModel(data);
  const actionFeed = Array.isArray(data.actionFeed) ? data.actionFeed : [];

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {data.complete ? (
              <Check className="size-4 text-emerald-600" aria-hidden="true" />
            ) : null}
            {data.complete ? 'Workspace setup complete' : 'Finish workspace setup'}
          </CardTitle>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls="workspace-action-feed"
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
        <CardContent id="workspace-action-feed">
          {view.nextStep?.status === 'blocked' ? (
            <p className="mb-3 flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="size-4" aria-hidden="true" />
              The next required step is blocked. Resolve its permission or provider prerequisite.
            </p>
          ) : null}
          <h3 className="sr-only">Prioritized workspace actions</h3>
          {!data.complete && actionFeed.length === 0 ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-destructive">
                Workspace actions are unavailable. Retry before treating setup as complete.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
                Retry workspace actions
              </Button>
            </div>
          ) : null}
          <ul aria-label="Prioritized workspace actions">
            {actionFeed.map((action) => (
              <WorkspaceActionRow key={action.id} action={action} />
            ))}
          </ul>
          {data.steps.length > 0 ? (
            <div className="mt-4 border-t pt-3">
              <h3 className="text-sm font-semibold">Readiness details</h3>
              <ul aria-label="Workspace readiness details">
                {data.steps.map((step) => (
                  <WorkspaceReadinessDetail key={step.id} step={step} />
                ))}
              </ul>
            </div>
          ) : null}
          <a
            className="mt-3 inline-block text-sm font-medium text-primary"
            href={docUrl('localQuickstart')}
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
