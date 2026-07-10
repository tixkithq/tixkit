'use client';

import * as React from 'react';
import { Check, ChevronsUpDown, Plus, UsersRound, Mail, Shield, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  adminApi,
  type AdminOrganization,
  type AdminTeamMember,
  type TeamMemberRole,
  type UpdateTeamMemberInput,
} from '@/lib/api';
import { getDisplayNameInitials } from '@/lib/utils';
import { isLocalKioskReturnTo } from '@/lib/permissions';
import { toast } from 'sonner';
import { useBootstrap } from '@/context/bootstrap-provider';
import { useAllEvents } from '@/hooks/use-all-events';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

const roleLabels: Record<TeamMemberRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  organizer: 'Organizer',
  viewer: 'Viewer',
  door_staff: 'Door staff',
  door_staff_sales: 'Door staff + sales',
};

const roleDescriptions: Partial<Record<TeamMemberRole, string>> = {
  admin: 'Full workspace access including settings and billing.',
  organizer: 'Run events, orders, messaging, check-in, and door sales.',
  viewer: 'Read-only access. Cannot scan or sell at the door.',
  door_staff: 'Scan tickets and view live admits only.',
  door_staff_sales: 'Scan tickets, live admits, and door sales (no refunds).',
};

type AssignableRole = Exclude<TeamMemberRole, 'owner'>;
type DoorInviteContext = { eventId: string; eventName: string; returnTo: string };

function isDoorInviteRole(role: TeamMemberRole): boolean {
  return role === 'door_staff' || role === 'door_staff_sales';
}

function isAssignableRole(role: TeamMemberRole): role is AssignableRole {
  return role !== 'owner';
}

function EventAccessPicker({
  events,
  loading,
  selectedIds,
  onSelectedIdsChange,
}: {
  events: Array<{ id: string; title: string }>;
  loading: boolean;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const selectedNames = events
    .filter((event) => selectedIds.includes(event.id))
    .map((event) => event.title);
  // oxlint-disable-next-line unicorn/no-array-sort -- sorting a copied array preserves immutability and the admin app intentionally targets an ES2022 runtime without Array.prototype.toSorted.
  const orderedEvents = [...events].sort(
    (left, right) => Number(selectedIds.includes(right.id)) - Number(selectedIds.includes(left.id)),
  );
  const label = loading
    ? 'Loading events…'
    : selectedNames.length === 0
      ? 'Choose one or more events'
      : selectedNames.length === 1
        ? selectedNames[0]
        : `${selectedNames.length} events selected`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="w-full justify-between font-normal"
          disabled={loading}
          aria-label={`Choose scanner events. Selected: ${selectedNames.join(', ') || 'none'}`}
          aria-expanded={open}
          aria-haspopup="listbox"
        >
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command>
          <CommandInput placeholder="Search events…" />
          <CommandList>
            <CommandEmpty>No events found.</CommandEmpty>
            {orderedEvents.map((event) => {
              const selected = selectedIds.includes(event.id);
              return (
                <CommandItem
                  key={event.id}
                  value={`${event.title} ${event.id}`}
                  onSelect={() =>
                    onSelectedIdsChange(
                      selected
                        ? selectedIds.filter((id) => id !== event.id)
                        : [...selectedIds, event.id],
                    )
                  }
                >
                  <Check className={selected ? 'opacity-100' : 'opacity-0'} />
                  <span className="truncate">{event.title}</span>
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function TeamView() {
  const {
    organizations,
    organizationId,
    brands = [],
    loading: bootstrapLoading,
    error: bootstrapError,
  } = useBootstrap();
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [inviteEmail, setInviteEmail] = React.useState('');
  const [inviteRole, setInviteRole] = React.useState<AssignableRole>('viewer');
  const [inviteBrandId, setInviteBrandId] = React.useState<string>('all');
  const [inviteScope, setInviteScope] = React.useState<'workspace' | 'event'>('workspace');
  const [inviteEventIds, setInviteEventIds] = React.useState<string[]>([]);
  const [doorInviteContext, setDoorInviteContext] = React.useState<DoorInviteContext | null>(null);
  const [editMember, setEditMember] = React.useState<AdminTeamMember | null>(null);
  const [editRole, setEditRole] = React.useState<AssignableRole>('viewer');
  const [editBrandId, setEditBrandId] = React.useState<string>('all');
  const [editScope, setEditScope] = React.useState<'workspace' | 'event'>('workspace');
  const [editEventIds, setEditEventIds] = React.useState<string[]>([]);
  const [organization, setOrganization] = React.useState<AdminOrganization | null>(null);
  const [members, setMembers] = React.useState<AdminTeamMember[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const orgBrands = React.useMemo(
    () => brands.filter((brand) => brand.organizationId === organizationId),
    [brands, organizationId],
  );
  const { events: organizationEvents, loading: eventsLoading } = useAllEvents({ organizationId });

  const loadTeam = React.useCallback(async () => {
    if (bootstrapLoading) return;

    setLoading(true);
    setError(null);

    if (bootstrapError) {
      setOrganization(null);
      setMembers([]);
      setError(bootstrapError);
      setLoading(false);
      return;
    }

    const selectedOrganization = organizations.find((org) => org.id === organizationId) ?? null;
    setOrganization(selectedOrganization);
    if (!selectedOrganization) {
      setMembers([]);
      setLoading(false);
      return;
    }

    const membersResult = await adminApi.listTeamMembers(selectedOrganization.id);
    if (!membersResult.ok) {
      setMembers([]);
      setError(membersResult.error.message);
      setLoading(false);
      return;
    }

    setMembers(membersResult.data);
    setLoading(false);
  }, [bootstrapError, bootstrapLoading, organizationId, organizations]);

  React.useEffect(() => {
    void loadTeam();
  }, [loadTeam]);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const eventId = params.get('eventId');
    const eventName = params.get('eventName')?.trim();
    const returnTo = params.get('returnTo');
    if (params.get('invite') !== '1' || !eventId || !returnTo || !isLocalKioskReturnTo(returnTo))
      return;
    setDoorInviteContext({
      eventId,
      eventName: eventName?.slice(0, 160) || eventId,
      returnTo,
    });
    setInviteRole('door_staff');
    setInviteScope('event');
    setInviteEventIds([eventId]);
    setInviteOpen(true);
  }, []);

  const openEdit = (member: AdminTeamMember) => {
    if (!isAssignableRole(member.role)) return;
    setEditMember(member);
    setEditRole(member.role);
    setEditBrandId(member.brandIds?.[0] ?? 'all');
    setEditScope(member.eventIds?.length ? 'event' : 'workspace');
    setEditEventIds(member.eventIds ?? []);
  };

  const handleInvite = async () => {
    if (!organization) {
      toast.error('Create a workspace before inviting members');
      return;
    }

    const email = inviteEmail.trim();
    if (!email) {
      toast.error('Enter an email address');
      return;
    }
    if (isDoorInviteRole(inviteRole) && inviteScope === 'event' && inviteEventIds.length === 0) {
      toast.error('Choose at least one event for scanner access');
      return;
    }

    setSubmitting(true);
    const result = await adminApi.inviteTeamMember(organization.id, {
      email,
      role: inviteRole,
      ...(isDoorInviteRole(inviteRole) && inviteScope === 'event'
        ? {
            eventIds: inviteEventIds,
            ...(doorInviteContext ? { returnTo: doorInviteContext.returnTo } : {}),
          }
        : isDoorInviteRole(inviteRole) && inviteBrandId !== 'all'
          ? { brandIds: [inviteBrandId] }
          : {}),
    });
    setSubmitting(false);

    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }

    setMembers((current) => {
      const existingIndex = current.findIndex((member) => member.id === result.data.id);
      if (existingIndex < 0) return [result.data, ...current];
      return current.map((member) => (member.id === result.data.id ? result.data : member));
    });
    toast.success(
      result.data.invitationDelivery === 'captured'
        ? `Invitation captured locally for ${email}; configure an email provider to deliver it.`
        : `Invitation sent to ${email}`,
    );
    setInviteEmail('');
    setInviteRole('viewer');
    setInviteBrandId('all');
    setInviteScope(doorInviteContext ? 'event' : 'workspace');
    setInviteEventIds(doorInviteContext ? [doorInviteContext.eventId] : []);
    setInviteOpen(false);
  };

  const handleUpdateRole = async () => {
    if (!organization || !editMember) return;
    if (isDoorInviteRole(editRole) && editScope === 'event' && editEventIds.length === 0) {
      toast.error('Choose at least one event for scanner access');
      return;
    }

    const input: UpdateTeamMemberInput = {
      role: editRole,
      ...(isDoorInviteRole(editRole) && editScope === 'event'
        ? { eventIds: editEventIds }
        : isDoorInviteRole(editRole) && editBrandId !== 'all'
          ? { brandIds: [editBrandId] }
          : {}),
    };

    setSubmitting(true);
    const result = await adminApi.updateTeamMember(organization.id, editMember.id, input);
    setSubmitting(false);

    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }

    setMembers((current) =>
      current.map((member) => (member.id === result.data.id ? result.data : member)),
    );
    toast.success(`Updated role for ${result.data.name || result.data.email}`);
    setEditMember(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Members</h1>
          <p className="text-sm text-muted-foreground">Members and roles</p>
        </div>
        <Button onClick={() => setInviteOpen(true)} disabled={!organization}>
          <Plus className="size-4" />
          Invite member
        </Button>
      </div>

      {bootstrapLoading || loading ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            Loading members...
          </CardContent>
        </Card>
      ) : error ? (
        <EmptyState
          icon={UsersRound}
          title="Members unavailable"
          description={error}
          action={
            <Button variant="outline" onClick={() => void loadTeam()}>
              Retry
            </Button>
          }
        />
      ) : !organization ? (
        <EmptyState
          icon={UsersRound}
          title="Select a workspace"
          description="Choose a workspace from the sidebar before managing member access."
        />
      ) : members.length === 0 ? (
        <EmptyState
          icon={UsersRound}
          title="No members yet"
          description="Invite members and assign roles to collaborate on events."
          action={
            <Button onClick={() => setInviteOpen(true)}>
              <Plus className="size-4" />
              Invite member
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {members.map((member) => (
            <Card key={member.id}>
              <CardContent className="flex flex-col items-start justify-between gap-3 p-4 sm:flex-row sm:items-center">
                <div className="flex min-w-0 items-start gap-3">
                  <Avatar className="size-10 shrink-0">
                    <AvatarFallback>{getDisplayNameInitials(member.name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="break-words font-medium">{member.name}</p>
                    <p className="break-all text-sm text-muted-foreground">{member.email}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3 sm:shrink-0 sm:justify-end">
                  <div className="flex items-center gap-1 text-sm text-muted-foreground">
                    <Shield className="size-4 shrink-0" />
                    <span>{roleLabels[member.role]}</span>
                  </div>
                  <Badge
                    variant={member.status === 'active' ? 'default' : 'secondary'}
                    className="shrink-0"
                  >
                    {member.status}
                  </Badge>
                  {isAssignableRole(member.role) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEdit(member)}
                      aria-label={`Change role for ${member.name || member.email}`}
                    >
                      <Pencil className="size-3.5" />
                      Change role
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {doorInviteContext
                ? `Invite staff to ${doorInviteContext.eventName}`
                : 'Invite Member'}
            </DialogTitle>
            <DialogDescription>
              {doorInviteContext
                ? 'Send an invitation with scanner access for this event.'
                : 'Send an invitation to join your workspace.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email Address</Label>
              <div className="relative">
                <Mail className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="invite-email"
                  type="email"
                  placeholder="member@example.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="ps-8"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select
                value={inviteRole}
                onValueChange={(value) => setInviteRole(value as AssignableRole)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="organizer">Organizer</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="door_staff">Door staff</SelectItem>
                  <SelectItem value="door_staff_sales">Door staff + sales</SelectItem>
                </SelectContent>
              </Select>
              {roleDescriptions[inviteRole] ? (
                <p className="text-xs text-muted-foreground">{roleDescriptions[inviteRole]}</p>
              ) : null}
            </div>
            {isDoorInviteRole(inviteRole) ? (
              <div className="space-y-2">
                <Label>Scanner access</Label>
                <Select
                  value={inviteScope === 'event' ? 'selected-events' : inviteBrandId}
                  onValueChange={(value) => {
                    if (value === 'selected-events') {
                      setInviteScope('event');
                      return;
                    }
                    setInviteScope('workspace');
                    setInviteBrandId(value);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose scanner access" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="selected-events">Selected events</SelectItem>
                    <SelectItem value="all">All events in this workspace</SelectItem>
                    {orgBrands.map((brand) => (
                      <SelectItem key={brand.id} value={brand.id}>
                        All events for {brand.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {inviteScope === 'event' ? (
                  <div className="space-y-2">
                    <Label>Events</Label>
                    <EventAccessPicker
                      events={organizationEvents}
                      loading={eventsLoading}
                      selectedIds={inviteEventIds}
                      onSelectedIdsChange={setInviteEventIds}
                    />
                    <p className="text-xs text-muted-foreground">
                      Choose every event this member should be able to scan.
                      {doorInviteContext
                        ? ` ${doorInviteContext.eventName} is preselected from the check-in kiosk.`
                        : ''}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    This access automatically includes the events described above.
                  </p>
                )}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleInvite} disabled={submitting}>
              {submitting ? 'Sending...' : 'Send Invitation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(editMember)}
        onOpenChange={(open) => {
          if (!open) setEditMember(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change role</DialogTitle>
            <DialogDescription>
              {editMember
                ? `Update access for ${editMember.name || editMember.email}.`
                : 'Update member access.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Role</Label>
              <Select
                value={editRole}
                onValueChange={(value) => setEditRole(value as AssignableRole)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="organizer">Organizer</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="door_staff">Door staff</SelectItem>
                  <SelectItem value="door_staff_sales">Door staff + sales</SelectItem>
                </SelectContent>
              </Select>
              {roleDescriptions[editRole] ? (
                <p className="text-xs text-muted-foreground">{roleDescriptions[editRole]}</p>
              ) : null}
            </div>
            {isDoorInviteRole(editRole) ? (
              <div className="space-y-2">
                <Label>Scanner access</Label>
                <Select
                  value={editScope === 'event' ? 'selected-events' : editBrandId}
                  onValueChange={(value) => {
                    if (value === 'selected-events') {
                      setEditScope('event');
                      return;
                    }
                    setEditScope('workspace');
                    setEditBrandId(value);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose scanner access" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="selected-events">Selected events</SelectItem>
                    <SelectItem value="all">All events in this workspace</SelectItem>
                    {orgBrands.map((brand) => (
                      <SelectItem key={brand.id} value={brand.id}>
                        All events for {brand.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {editScope === 'event' ? (
                  <div className="space-y-2">
                    <Label>Events</Label>
                    <EventAccessPicker
                      events={organizationEvents}
                      loading={eventsLoading}
                      selectedIds={editEventIds}
                      onSelectedIdsChange={setEditEventIds}
                    />
                  </div>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Changing role rewrites this member&apos;s permission grants for the workspace.
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Saving replaces this member&apos;s workspace permission grants from the role matrix.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditMember(null)}>
              Cancel
            </Button>
            <Button onClick={() => void handleUpdateRole()} disabled={submitting || !editMember}>
              {submitting ? 'Saving...' : 'Save role'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
