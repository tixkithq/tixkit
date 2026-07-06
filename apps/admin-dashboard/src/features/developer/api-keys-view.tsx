'use client';

import * as React from 'react';
import { Plus, KeyRound } from 'lucide-react';
import { type AdminApiKey, adminApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreHorizontal, Ban } from 'lucide-react';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { useBootstrap } from '@/context/bootstrap-provider';
import { formatDateTime } from '@/lib/format';
import { ApiKeyFormDialog, RevokeApiKeyDialog } from './api-key-form';

export function ApiKeysView() {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [revokingKey, setRevokingKey] = React.useState<AdminApiKey | null>(null);
  const [revokeOpen, setRevokeOpen] = React.useState(false);
  const { organizationId } = useBootstrap();
  const { data, loading, error, refetch } = useAdminQuery(
    ['listApiKeys', organizationId],
    () => adminApi.listApiKeys(organizationId ? { organizationId } : undefined),
  );

  const apiKeys = data ?? [];

  const handleRevoke = (key: AdminApiKey) => {
    setRevokingKey(key);
    setRevokeOpen(true);
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (error && apiKeys.length === 0) {
    return (
      <EmptyState
        icon={KeyRound}
        title="Failed to load API keys"
        description={error.message}
        action={<Button onClick={refetch}>Try again</Button>}
      />
    );
  }

  if (apiKeys.length === 0) {
    return (
      <>
        <EmptyState
          icon={KeyRound}
          title="No API keys yet"
          description="Create a scoped API key to authenticate programmatic requests."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              Create API key
            </Button>
          }
        />
        <ApiKeyFormDialog open={createOpen} onOpenChange={setCreateOpen} onSuccess={refetch} />
      </>
    );
  }

  return (
    <>
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          Create API key
        </Button>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Prefix</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last Used</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-[50px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {apiKeys.map((key) => {
              const isRevoked = !!key.revokedAt;
              const isExpired = key.expiresAt && new Date(key.expiresAt) < new Date();
              const status = isRevoked ? 'revoked' : isExpired ? 'expired' : 'active';

              return (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {key.keyPrefix}...
                  </TableCell>
                  <TableCell>
                    <Badge variant={status === 'active' ? 'default' : 'secondary'}>{status}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {key.lastUsedAt ? formatDateTime(key.lastUsedAt) : 'Never'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDateTime(key.createdAt)}
                  </TableCell>
                  <TableCell>
                    {status === 'active' && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem variant="destructive" onClick={() => handleRevoke(key)}>
                            <Ban className="size-4" />
                            Revoke
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <ApiKeyFormDialog open={createOpen} onOpenChange={setCreateOpen} onSuccess={refetch} />
      <RevokeApiKeyDialog
        apiKey={revokingKey}
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        onSuccess={refetch}
      />
    </>
  );
}
