'use client';

import * as React from 'react';
import { Download, Eraser, ScrollText } from 'lucide-react';
import { toast } from 'sonner';
import {
  type AdminAuditLog,
  type AdminPrivacyRequest,
  type CreatePrivacyRequestInput,
  adminApi,
} from '@/lib/api';
import { auditLogTableSchema, privacyRequestTableSchema } from '@/lib/table-schemas';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DataTable, useMemoryTableState } from '@/components/data-table';
import { TextCell, TimestampCell } from '@/components/data-table/cells';
import { useAdminTableData } from '@/hooks/use-admin-table-data';
import { useBootstrap } from '@/context/bootstrap-provider';
import { formatDateTime } from '@/lib/format';
import type { ColumnDef } from '@tanstack/react-table';

type RequestType = 'export' | 'erasure';
type SubjectType = 'buyer' | 'attendee';

const auditLogColumns: ColumnDef<AdminAuditLog>[] = [
  {
    id: 'action',
    accessorKey: 'action',
    header: 'Action',
    cell: ({ row }) => <span className="font-medium text-sm">{row.original.action}</span>,
  },
  {
    id: 'actorId',
    accessorKey: 'actorId',
    header: 'Actor',
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.actorId}</span>,
  },
  {
    id: 'resourceType',
    accessorKey: 'resourceType',
    header: 'Target',
    cell: ({ row }) => (
      <div>
        <div className="text-sm">{row.original.resourceType}</div>
        <div className="font-mono text-xs text-muted-foreground">{row.original.resourceId}</div>
      </div>
    ),
  },
  {
    id: 'createdAt',
    accessorKey: 'createdAt',
    header: 'Created',
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {formatDateTime(row.original.createdAt)}
      </span>
    ),
  },
];

const privacyRequestColumns: ColumnDef<AdminPrivacyRequest>[] = [
  {
    id: 'requestType',
    accessorKey: 'requestType',
    header: 'Type',
    cell: ({ row }) => <span className="capitalize">{row.original.requestType}</span>,
  },
  {
    id: 'subject',
    header: 'Subject',
    cell: ({ row }) => (
      <div>
        <div className="text-sm">{row.original.subjectEmail ?? row.original.subjectId ?? 'Subject'}</div>
        <div className="text-xs text-muted-foreground">{row.original.subjectType}</div>
      </div>
    ),
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <Badge variant={row.original.status === 'failed' ? 'destructive' : 'secondary'}>
        {row.original.status}
      </Badge>
    ),
  },
  {
    id: 'createdAt',
    accessorKey: 'createdAt',
    header: 'Requested',
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {formatDateTime(row.original.createdAt)}
      </span>
    ),
  },
];

export function AuditLogView() {
  const { organizationId: bootstrapOrgId, brandId: bootstrapBrandId } = useBootstrap();
  const [organizationId, setOrganizationId] = React.useState('');
  const [brandId, setBrandId] = React.useState('');
  const [requestType, setRequestType] = React.useState<RequestType>('export');
  const [subjectType, setSubjectType] = React.useState<SubjectType>('buyer');
  const [subjectEmail, setSubjectEmail] = React.useState('');
  const [subjectId, setSubjectId] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (bootstrapOrgId && !organizationId) setOrganizationId(bootstrapOrgId);
  }, [bootstrapOrgId, organizationId]);
  React.useEffect(() => {
    if (bootstrapBrandId && !brandId) setBrandId(bootstrapBrandId);
  }, [bootstrapBrandId, brandId]);

  const auditState = useMemoryTableState({ limit: 50, includeFacets: true });
  const privacyState = useMemoryTableState({ limit: 25, includeFacets: true });

  const audit = useAdminTableData<AdminAuditLog>({
    schema: auditLogTableSchema,
    query: auditState.query,
    fetcher: (tableQuery) =>
      adminApi.listAuditLogs({
        ...tableQuery,
        organizationId: organizationId || undefined,
        brandId: brandId || undefined,
      }),
  });

  const privacy = useAdminTableData<AdminPrivacyRequest>({
    schema: privacyRequestTableSchema,
    query: privacyState.query,
    fetcher: (tableQuery) =>
      adminApi.listPrivacyRequests({
        ...tableQuery,
        organizationId: organizationId || undefined,
        brandId: brandId || undefined,
      }),
  });

  const submitPrivacyRequest = async () => {
    if (!organizationId.trim()) {
      toast.error('Organization ID is required');
      return;
    }
    if (!subjectEmail.trim() && !subjectId.trim()) {
      toast.error('Subject email or subject ID is required');
      return;
    }

    setSubmitting(true);
    const basePayload = {
      organizationId: organizationId.trim(),
      brandId: brandId.trim() || undefined,
      subjectType,
    };
    const trimmedSubjectEmail = subjectEmail.trim();
    const trimmedSubjectId = subjectId.trim();
    const payload: CreatePrivacyRequestInput = trimmedSubjectEmail
      ? trimmedSubjectId
        ? { ...basePayload, subjectEmail: trimmedSubjectEmail, subjectId: trimmedSubjectId }
        : { ...basePayload, subjectEmail: trimmedSubjectEmail }
      : { ...basePayload, subjectId: trimmedSubjectId };
    const result =
      requestType === 'export'
        ? await adminApi.createPrivacyExport(payload)
        : await adminApi.createPrivacyErasure(payload);
    setSubmitting(false);

    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }

    toast.success(`Privacy ${requestType} queued`);
    privacy.refetch();
    audit.refetch();
  };

  return (
    <div className="space-y-8">
      <div className="grid gap-3 md:grid-cols-[1fr_1fr]">
        <div className="space-y-2">
          <Label htmlFor="audit-org">Organization</Label>
          <Input
            id="audit-org"
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            placeholder="org_..."
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="audit-brand">Brand</Label>
          <Input
            id="audit-brand"
            value={brandId}
            onChange={(event) => setBrandId(event.target.value)}
            placeholder="brd_..."
          />
        </div>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Audit events</h2>
          <p className="text-sm text-muted-foreground">Privileged mutation history by scope.</p>
        </div>
        <DataTable
          schema={auditLogTableSchema}
          columns={auditLogColumns}
          data={audit.data}
          query={auditState.query}
          onQueryChange={auditState.updateQuery}
          loading={audit.loading}
          error={audit.error ? { message: audit.error.message } : undefined}
          onRetry={() => audit.refetch()}
          getRowId={(row) => row.id}
          emptyState={
            <EmptyState
              icon={ScrollText}
              title="No audit events found"
              description="Adjust filters or create a privileged change to generate an audit event."
            />
          }
          renderRowSheet={(row) =>
            row ? <AuditLogRowSheet row={row} /> : null
          }
        />
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">GDPR requests</h2>
          <p className="text-sm text-muted-foreground">
            Queue buyer or attendee data export and erasure workflows.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-6">
          <Button
            type="button"
            variant={requestType === 'export' ? 'default' : 'outline'}
            onClick={() => setRequestType('export')}
          >
            <Download className="size-4" />
            Export
          </Button>
          <Button
            type="button"
            variant={requestType === 'erasure' ? 'default' : 'outline'}
            onClick={() => setRequestType('erasure')}
          >
            <Eraser className="size-4" />
            Erase
          </Button>
          <Button
            type="button"
            variant={subjectType === 'buyer' ? 'secondary' : 'outline'}
            onClick={() => setSubjectType('buyer')}
          >
            Buyer
          </Button>
          <Button
            type="button"
            variant={subjectType === 'attendee' ? 'secondary' : 'outline'}
            onClick={() => setSubjectType('attendee')}
          >
            Attendee
          </Button>
          <Input
            value={subjectEmail}
            onChange={(event) => setSubjectEmail(event.target.value)}
            placeholder="subject@example.com"
          />
          <Input
            value={subjectId}
            onChange={(event) => setSubjectId(event.target.value)}
            placeholder="att_... or ord_..."
          />
        </div>
        <Button onClick={submitPrivacyRequest} disabled={submitting}>
          {submitting ? 'Queuing...' : `Queue ${requestType}`}
        </Button>
        <DataTable
          schema={privacyRequestTableSchema}
          columns={privacyRequestColumns}
          data={privacy.data}
          query={privacyState.query}
          onQueryChange={privacyState.updateQuery}
          loading={privacy.loading}
          error={privacy.error ? { message: privacy.error.message } : undefined}
          onRetry={() => privacy.refetch()}
          getRowId={(row) => row.id}
          emptyState={
            <EmptyState
              icon={Download}
              title="No GDPR requests"
              description="Data exports and erasures queued from this page will appear here."
            />
          }
          renderRowSheet={(row) =>
            row ? <PrivacyRequestRowSheet row={row} /> : null
          }
        />
      </section>
    </div>
  );
}

function AuditLogRowSheet({ row }: { row: AdminAuditLog }) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">{row.action}</h3>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Actor</dt>
          <dd className="mt-1 font-mono text-xs"><TextCell value={row.actorId} /></dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Resource</dt>
          <dd className="mt-1">
            <div className="text-sm">{row.resourceType}</div>
            <div className="font-mono text-xs text-muted-foreground">{row.resourceId}</div>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Organization</dt>
          <dd className="mt-1"><TextCell value={row.organizationId ?? 'tenant'} /></dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Brand</dt>
          <dd className="mt-1"><TextCell value={row.brandId ?? 'all brands'} /></dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Request ID</dt>
          <dd className="mt-1 font-mono text-xs"><TextCell value={row.requestId ?? '-'} /></dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Created</dt>
          <dd className="mt-1"><TimestampCell value={row.createdAt} showTime /></dd>
        </div>
      </dl>
    </div>
  );
}

function PrivacyRequestRowSheet({ row }: { row: AdminPrivacyRequest }) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold capitalize">{row.requestType} request</h3>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="mt-1">
            <Badge variant={row.status === 'failed' ? 'destructive' : 'secondary'}>
              {row.status}
            </Badge>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Subject Type</dt>
          <dd className="mt-1 capitalize">{row.subjectType}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Subject Email</dt>
          <dd className="mt-1"><TextCell value={row.subjectEmail ?? '-'} /></dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Subject ID</dt>
          <dd className="mt-1 font-mono text-xs"><TextCell value={row.subjectId ?? '-'} /></dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Requested</dt>
          <dd className="mt-1"><TimestampCell value={row.createdAt} showTime /></dd>
        </div>
        {row.completedAt && (
          <div>
            <dt className="text-muted-foreground">Completed</dt>
            <dd className="mt-1"><TimestampCell value={row.completedAt} showTime /></dd>
          </div>
        )}
        {row.error && (
          <div className="col-span-2">
            <dt className="text-muted-foreground">Error</dt>
            <dd className="mt-1 text-sm text-red-600 dark:text-red-400">{row.error}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
