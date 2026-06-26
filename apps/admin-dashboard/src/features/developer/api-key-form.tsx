'use client'

import * as React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Copy, Check, KeyRound, AlertTriangle } from 'lucide-react'
import { type AdminApiKey, type CreateApiKeyInput, adminApi } from '@/lib/api'
import { useBootstrap } from '@/context/bootstrap-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'

/** Common API key scopes offered in the create-key dialog. */
export const API_KEY_SCOPES = [
  'events.read',
  'events.write',
  'orders.read',
  'orders.write',
  'attendees.read',
  'attendees.write',
  'checkins.read',
  'checkins.write',
  'messages.write',
  'reports.read',
  'developers.write',
  'settings.write',
  'billing.write',
] as const

const DEFAULT_SCOPES = ['events.read', 'events.write', 'orders.read']

const apiKeySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  scopes: z.array(z.string()),
})

type ApiKeyFormValues = z.infer<typeof apiKeySchema>

type ApiKeyFormDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

export function ApiKeyFormDialog({
  open,
  onOpenChange,
  onSuccess,
}: ApiKeyFormDialogProps) {
  const [submitting, setSubmitting] = React.useState(false)
  const [createdKey, setCreatedKey] = React.useState<AdminApiKey | null>(null)
  const [oneTimeSecret, setOneTimeSecret] = React.useState<string>('')
  const [copied, setCopied] = React.useState(false)
  const { organizationId } = useBootstrap()

  const form = useForm<ApiKeyFormValues>({
    resolver: zodResolver(apiKeySchema),
    defaultValues: { name: '', scopes: DEFAULT_SCOPES },
  })

  const onSubmit = async (values: ApiKeyFormValues) => {
    if (!organizationId) {
      toast.error('Organization context is required to create an API key.')
      return
    }
    setSubmitting(true)
    const input: CreateApiKeyInput = {
      organizationId,
      name: values.name,
      scopes: values.scopes,
    }
    const result = await adminApi.createApiKey(input)
    setSubmitting(false)
    if (result.ok) {
      setCreatedKey(result.data)
      // The backend returns the real secret exactly once on creation.
      // Display that value; never fabricate a key client-side.
      setOneTimeSecret(result.data.apiKey ?? '')
      form.reset({ name: '', scopes: DEFAULT_SCOPES })
      onSuccess?.()
    } else {
      toast.error(result.error.message)
    }
  }

  const handleCopy = () => {
    if (!oneTimeSecret) return
    navigator.clipboard.writeText(oneTimeSecret)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleClose = () => {
    setCreatedKey(null)
    setOneTimeSecret('')
    setCopied(false)
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open || !!createdKey}
      onOpenChange={(v) => {
        if (!v) handleClose()
      }}
    >
      <DialogContent>
        {createdKey ? (
          <>
            <DialogHeader>
              <DialogTitle>API Key Created</DialogTitle>
              <DialogDescription>
                Copy your API key now. For security, it will not be shown again.
              </DialogDescription>
            </DialogHeader>
            <div className='space-y-4'>
              <div className='flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3'>
                <AlertTriangle className='size-5 text-amber-600 dark:text-amber-400' />
                <p className='text-sm text-amber-700 dark:text-amber-400'>
                  Store this key securely. You will not be able to see it again.
                </p>
              </div>
              {oneTimeSecret ? (
                <div className='flex items-center gap-2'>
                  <code className='flex-1 rounded-md border bg-muted p-2 text-sm font-mono break-all'>
                    {oneTimeSecret}
                  </code>
                  <Button
                    size='icon'
                    variant='outline'
                    onClick={handleCopy}
                    aria-label='Copy API key'
                  >
                    {copied ? (
                      <Check className='size-4 text-emerald-600' />
                    ) : (
                      <Copy className='size-4' />
                    )}
                  </Button>
                </div>
              ) : (
                <p className='text-sm text-muted-foreground'>
                  The API key was created but the secret was not returned. If
                  this persists, contact your administrator.
                </p>
              )}
              <div className='flex items-center gap-2 text-sm text-muted-foreground'>
                <KeyRound className='size-4' />
                <span>Name: {createdKey.name}</span>
                <Badge variant='outline'>{createdKey.keyPrefix}...</Badge>
              </div>
              {createdKey.scopes && createdKey.scopes.length > 0 ? (
                <div className='flex flex-wrap gap-1'>
                  {createdKey.scopes.map((scope) => (
                    <Badge key={scope} variant='secondary' className='text-xs'>
                      {scope}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
            <DialogFooter>
              <Button onClick={handleClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API Key</DialogTitle>
              <DialogDescription>
                Generate a scoped API key for programmatic access.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className='space-y-4'>
                <FormField
                  control={form.control}
                  name='name'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input
                          placeholder='Production Server'
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        A descriptive name to identify this key
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name='scopes'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Scopes</FormLabel>
                      <FormDescription>
                        Choose what this key can access.
                      </FormDescription>
                      <div className='grid gap-2 sm:grid-cols-2'>
                        {API_KEY_SCOPES.map((scope) => {
                          const checked = field.value?.includes(scope) ?? false
                          return (
                            <label
                              key={scope}
                              className='flex items-center gap-2 text-sm'
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(value) => {
                                  const next = new Set(field.value ?? [])
                                  if (value) next.add(scope)
                                  else next.delete(scope)
                                  field.onChange(Array.from(next))
                                }}
                              />
                              <span className='font-mono text-xs'>{scope}</span>
                            </label>
                          )
                        })}
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter>
                  <Button
                    type='button'
                    variant='outline'
                    onClick={handleClose}
                  >
                    Cancel
                  </Button>
                  <Button type='submit' disabled={submitting}>
                    {submitting ? 'Creating...' : 'Create Key'}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

type RevokeKeyDialogProps = {
  apiKey: AdminApiKey | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

export function RevokeApiKeyDialog({
  apiKey,
  open,
  onOpenChange,
  onSuccess,
}: RevokeKeyDialogProps) {
  const [pending, setPending] = React.useState(false)

  const handleRevoke = async () => {
    if (!apiKey) return
    setPending(true)
    const result = await adminApi.revokeApiKey(apiKey.id)
    setPending(false)
    if (result.ok) {
      toast.success('API key revoked')
      onOpenChange(false)
      onSuccess?.()
    } else {
      toast.error(result.error.message)
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title='Revoke API Key'
      description={
        <>
          Are you sure you want to revoke the key <strong>{apiKey?.name}</strong>?
          This action cannot be undone and any services using this key will
          immediately lose access.
        </>
      }
      confirmText='Revoke'
      variant='destructive'
      pending={pending}
      onConfirm={handleRevoke}
    />
  )
}
