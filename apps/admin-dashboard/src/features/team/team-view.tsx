'use client'

import * as React from 'react'
import { Plus, UsersRound, Mail, Shield } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { adminApi, type AdminOrganization, type AdminTeamMember, type TeamMemberRole } from '@/lib/api'
import { getDisplayNameInitials } from '@/lib/utils'
import { toast } from 'sonner'
import { useBootstrap } from '@/context/bootstrap-provider'

const roleLabels: Record<TeamMemberRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  organizer: 'Organizer',
  viewer: 'Viewer',
}

export function TeamView() {
  const { organizations, organizationId, loading: bootstrapLoading, error: bootstrapError } = useBootstrap()
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [inviteEmail, setInviteEmail] = React.useState('')
  const [inviteRole, setInviteRole] = React.useState<TeamMemberRole>('viewer')
  const [organization, setOrganization] = React.useState<AdminOrganization | null>(null)
  const [members, setMembers] = React.useState<AdminTeamMember[]>([])
  const [loading, setLoading] = React.useState(true)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const loadTeam = React.useCallback(async () => {
    if (bootstrapLoading) return

    setLoading(true)
    setError(null)

    if (bootstrapError) {
      setOrganization(null)
      setMembers([])
      setError(bootstrapError)
      setLoading(false)
      return
    }

    const selectedOrganization = organizations.find((org) => org.id === organizationId) ?? null
    setOrganization(selectedOrganization)
    if (!selectedOrganization) {
      setMembers([])
      setLoading(false)
      return
    }

    const membersResult = await adminApi.listTeamMembers(selectedOrganization.id)
    if (!membersResult.ok) {
      setMembers([])
      setError(membersResult.error.message)
      setLoading(false)
      return
    }

    setMembers(membersResult.data)
    setLoading(false)
  }, [bootstrapError, bootstrapLoading, organizationId, organizations])

  React.useEffect(() => {
    void loadTeam()
  }, [loadTeam])

  const handleInvite = async () => {
    if (!organization) {
      toast.error('Create a workspace before inviting members')
      return
    }

    const email = inviteEmail.trim()
    if (!email) {
      toast.error('Enter an email address')
      return
    }

    setSubmitting(true)
    const result = await adminApi.inviteTeamMember(organization.id, {
      email,
      role: inviteRole,
    })
    setSubmitting(false)

    if (!result.ok) {
      toast.error(result.error.message)
      return
    }

    setMembers((current) => [result.data, ...current])
    toast.success(`Invitation sent to ${email}`)
    setInviteEmail('')
    setInviteRole('viewer')
    setInviteOpen(false)
  }

  return (
    <div className='space-y-6'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='space-y-1'>
          <h1 className='text-2xl font-bold tracking-tight'>Members</h1>
          <p className='text-sm text-muted-foreground'>Members and roles</p>
        </div>
        <Button onClick={() => setInviteOpen(true)} disabled={!organization}>
          <Plus className='size-4' />
          Invite member
        </Button>
      </div>

      {bootstrapLoading || loading ? (
        <Card>
          <CardContent className='p-4 text-sm text-muted-foreground'>
            Loading members...
          </CardContent>
        </Card>
      ) : error ? (
        <EmptyState
          icon={UsersRound}
          title='Members unavailable'
          description={error}
          action={
            <Button variant='outline' onClick={() => void loadTeam()}>
              Retry
            </Button>
          }
        />
      ) : !organization ? (
        <EmptyState
          icon={UsersRound}
          title='Select a workspace'
          description='Choose a workspace from the sidebar before managing member access.'
        />
      ) : members.length === 0 ? (
        <EmptyState
          icon={UsersRound}
          title='No members yet'
          description='Invite members and assign roles to collaborate on events.'
          action={
            <Button onClick={() => setInviteOpen(true)}>
              <Plus className='size-4' />
              Invite member
            </Button>
          }
        />
      ) : (
        <div className='space-y-3'>
          {members.map((member) => (
            <Card key={member.id}>
              <CardContent className='flex items-center justify-between p-4'>
                <div className='flex items-center gap-3'>
                  <Avatar className='size-10'>
                    <AvatarFallback>
                      {getDisplayNameInitials(member.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className='font-medium'>{member.name}</p>
                    <p className='text-sm text-muted-foreground'>
                      {member.email}
                    </p>
                  </div>
                </div>
                <div className='flex items-center gap-3'>
                  <div className='flex items-center gap-1 text-sm text-muted-foreground'>
                    <Shield className='size-4' />
                    {roleLabels[member.role]}
                  </div>
                  <Badge
                    variant={member.status === 'active' ? 'default' : 'secondary'}
                  >
                    {member.status}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite Member</DialogTitle>
            <DialogDescription>
              Send an invitation to join your workspace.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='invite-email'>Email Address</Label>
              <div className='relative'>
                <Mail className='absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground' />
                <Input
                  id='invite-email'
                  type='email'
                  placeholder='member@example.com'
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className='ps-8'
                />
              </div>
            </div>
            <div className='space-y-2'>
              <Label>Role</Label>
              <Select value={inviteRole} onValueChange={(value) => setInviteRole(value as TeamMemberRole)}>
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='admin'>Admin</SelectItem>
                  <SelectItem value='organizer'>Organizer</SelectItem>
                  <SelectItem value='viewer'>Viewer</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setInviteOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleInvite} disabled={submitting}>
              {submitting ? 'Sending...' : 'Send Invitation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
