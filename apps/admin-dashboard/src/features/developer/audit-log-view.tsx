'use client';

import * as React from 'react';
import { Download, Eraser, RefreshCw, ScrollText } from 'lucide-react';
import { toast } from 'sonner';
import { type AdminAuditLog, type AdminPrivacyRequest, adminApi } from '@/lib/api';
import { ApiErrorState } from '@/components/api-error-state';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAdminData } from '@/hooks/use-admin-data';
import { formatDateTime } from '@/lib/format';

type RequestType = 'export' | 'erasure';
type SubjectType = 'buyer' | 'attendee';

function AuditRows({ rows }: { rows: AdminAuditLog[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ScrollText}
        title="No audit events found"
        description="Adjust filters or create a privileged change to generate an audit event."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-md border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Action</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Request</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-medium">{row.action}</TableCell>
              <TableCell className="font-mono text-xs">{row.actorId}</TableCell>
              <TableCell>
                <div className="text-sm">{row.resourceType}</div>
                <div className="font-mono text-xs text-muted-foreground">{row.resourceId}</div>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                <div>{row.organizationId ?? 'tenant'}</div>
                <div>{row.brandId ?? 'all brands'}</div>
              </TableCell>
              <TableCell className="font-mono text-xs">{row.requestId ?? '-'}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatDateTime(row.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function PrivacyRows({ rows }: { rows: AdminPrivacyRequest[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Download}
        title="No GDPR requests"
        description="Data exports and erasures queued from this page will appear here."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-md border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Type</TableHead>
            <TableHead>Subject</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Requested</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="capitalize">{row.requestType}</TableCell>
              <TableCell>
                <div>{row.subjectEmail ?? row.subjectId ?? 'Subject'}</div>
                <div className="text-xs text-muted-foreground">{row.subjectType}</div>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                <div>{row.organizationId}</div>
                <div>{row.brandId ?? 'all brands'}</div>
              </TableCell>
              <TableCell>
                <Badge variant={row.status === 'failed' ? 'destructive' : 'secondary'}>
                  {row.status}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatDateTime(row.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function AuditLogView() {
  const [action, setAction] = React.useState('');
  const [organizationId, setOrganizationId] = React.useState('');
  const [brandId, setBrandId] = React.useState('');
  const [requestType, setRequestType] = React.useState<RequestType>('export');
  const [subjectType, setSubjectType] = React.useState<SubjectType>('buyer');
  const [subjectEmail, setSubjectEmail] = React.useState('');
  const [subjectId, setSubjectId] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const audit = useAdminData(
    () =>
      adminApi.listAuditLogs({
        limit: 50,
        organizationId: organizationId || undefined,
        brandId: brandId || undefined,
        action: action || undefined,
      }),
    [action, organizationId, brandId],
  );
  const privacy = useAdminData(() => adminApi.listPrivacyRequests({ limit: 25 }), []);

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
    const payload = {
      organizationId: organizationId.trim(),
      brandId: brandId.trim() || undefined,
      subjectType,
      subjectEmail: subjectEmail.trim() || undefined,
      subjectId: subjectId.trim() || undefined,
    };
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
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
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
        <div className="space-y-2">
          <Label htmlFor="audit-action">Action</Label>
          <Input
            id="audit-action"
            value={action}
            onChange={(event) => setAction(event.target.value)}
            placeholder="privacy.export.requested"
          />
        </div>
        <div className="flex items-end">
          <Button variant="outline" onClick={audit.refetch}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        </div>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Audit events</h2>
          <p className="text-sm text-muted-foreground">Privileged mutation history by scope.</p>
        </div>
        {audit.loading ? (
          <Skeleton className="h-56 w-full" />
        ) : audit.error ? (
          <ApiErrorState error={audit.error} onRetry={audit.refetch} />
        ) : (
          <AuditRows rows={audit.data?.items ?? []} />
        )}
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
        {privacy.loading ? (
          <Skeleton className="h-48 w-full" />
        ) : privacy.error ? (
          <ApiErrorState error={privacy.error} onRetry={privacy.refetch} />
        ) : (
          <PrivacyRows rows={privacy.data?.items ?? []} />
        )}
      </section>
    </div>
  );
}
