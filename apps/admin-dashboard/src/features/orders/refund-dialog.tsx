'use client'

import * as React from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import {
  type AdminOrderListItem,
  type RefundOrderInput,
  adminApi,
} from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import { Button } from '@/components/ui/button'
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
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'

const REFUND_REASONS = [
  'duplicate',
  'fraudulent',
  'requested_by_customer',
  'abandoned',
  'other',
] as const

type RefundDialogProps = {
  order: AdminOrderListItem
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

export function RefundDialog({
  order,
  open,
  onOpenChange,
  onSuccess,
}: RefundDialogProps) {
  const [mode, setMode] = React.useState<'full' | 'partial'>('full')
  const [amountInput, setAmountInput] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [voidTickets, setVoidTickets] = React.useState(true)
  const [restoreInventory, setRestoreInventory] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const refundableCents = order.totalCents - order.refundedCents

  // Reset form state whenever the dialog opens for a different order.
  React.useEffect(() => {
    if (open) {
      setMode('full')
      setAmountInput('')
      setReason('')
      setVoidTickets(true)
      setRestoreInventory(false)
      setPending(false)
      setError(null)
    }
  }, [open, order.id])

  const parsedAmountCents = React.useMemo(() => {
    if (mode !== 'partial') return undefined
    const parsed = parseFloat(amountInput)
    if (!Number.isFinite(parsed)) return null
    return Math.round(parsed * 100)
  }, [mode, amountInput])

  const validationError = React.useMemo(() => {
    if (!reason.trim()) {
      return 'A refund reason is required.'
    }
    if (mode === 'partial') {
      if (parsedAmountCents === null || parsedAmountCents === undefined) {
        return 'Enter a valid refund amount.'
      }
      if (parsedAmountCents <= 0) {
        return 'Refund amount must be greater than zero.'
      }
      if (parsedAmountCents > refundableCents) {
        return `Refund amount cannot exceed the remaining refundable balance (${formatCurrency(refundableCents, order.currency)}).`
      }
    }
    return null
  }, [reason, mode, parsedAmountCents, refundableCents, order.currency])

  const canSubmit = !validationError && !pending

  const handleSubmit = async () => {
    if (validationError) {
      setError(validationError)
      return
    }

    const input: RefundOrderInput = {
      reason: reason.trim(),
      voidTickets,
      restoreInventory,
    }
    if (mode === 'partial' && parsedAmountCents != null) {
      input.amountCents = parsedAmountCents
    }

    setPending(true)
    setError(null)

    const result = await adminApi.refundOrder(order.id, input)

    setPending(false)

    if (result.ok) {
      toast.success(result.data.message || 'Refund workflow queued')
      onOpenChange(false)
      onSuccess?.()
    } else {
      setError(result.error.message)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <RotateCcw className='size-5' />
            Refund order {order.id}
          </DialogTitle>
          <DialogDescription>
            Order total: {formatCurrency(order.totalCents, order.currency)}
            {order.refundedCents > 0 && (
              <>
                {' '}
                · Already refunded:{' '}
                {formatCurrency(order.refundedCents, order.currency)}
              </>
            )}
            {' '}
            · Refundable:{' '}
            {formatCurrency(refundableCents, order.currency)}
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-4'>
          {/* Refund mode */}
          <div className='space-y-2'>
            <Label>Refund type</Label>
            <Select
              value={mode}
              onValueChange={(value) => setMode(value as 'full' | 'partial')}
            >
              <SelectTrigger className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='full'>
                  Full refund ({formatCurrency(refundableCents, order.currency)})
                </SelectItem>
                <SelectItem value='partial'>Partial refund</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Amount (partial only) */}
          {mode === 'partial' && (
            <div className='space-y-2'>
              <Label htmlFor='refund-amount'>
                Amount ({order.currency})
              </Label>
              <Input
                id='refund-amount'
                type='number'
                inputMode='decimal'
                step='0.01'
                min='0'
                placeholder='0.00'
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                aria-invalid={!!validationError && mode === 'partial'}
              />
              <p className='text-xs text-muted-foreground'>
                Maximum: {formatCurrency(refundableCents, order.currency)}
              </p>
            </div>
          )}

          {/* Reason */}
          <div className='space-y-2'>
            <Label htmlFor='refund-reason'>
              Reason <span className='text-destructive'>*</span>
            </Label>
            <Select
              value={REFUND_REASONS.includes(reason as (typeof REFUND_REASONS)[number]) ? reason : 'custom'}
              onValueChange={(value) => {
                if (value === 'custom') {
                  setReason('')
                } else {
                  setReason(value)
                }
              }}
            >
              <SelectTrigger className='w-full'>
                <SelectValue placeholder='Select a reason' />
              </SelectTrigger>
              <SelectContent>
                {REFUND_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r.replace(/_/g, ' ')}
                  </SelectItem>
                ))}
                <SelectItem value='custom'>Custom reason</SelectItem>
              </SelectContent>
            </Select>
            <Textarea
              id='refund-reason'
              placeholder='Describe the refund reason (required)'
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              aria-invalid={!!validationError && !reason.trim()}
            />
          </div>

          <Separator />

          {/* Options */}
          <div className='space-y-3'>
            <div className='flex items-center justify-between gap-4'>
              <div className='space-y-0.5'>
                <Label htmlFor='void-tickets'>Void tickets</Label>
                <p className='text-xs text-muted-foreground'>
                  Mark all tickets in this order as void.
                </p>
              </div>
              <Switch
                id='void-tickets'
                checked={voidTickets}
                onCheckedChange={setVoidTickets}
              />
            </div>
            <div className='flex items-center justify-between gap-4'>
              <div className='space-y-0.5'>
                <Label htmlFor='restore-inventory'>Restore inventory</Label>
                <p className='text-xs text-muted-foreground'>
                  Return reserved capacity to the inventory pool.
                </p>
              </div>
              <Switch
                id='restore-inventory'
                checked={restoreInventory}
                onCheckedChange={setRestoreInventory}
              />
            </div>
          </div>

          {/* Error display */}
          {(error || validationError) && (
            <p className='text-sm text-destructive' role='alert'>
              {error || validationError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant='outline'
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            variant='destructive'
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {pending && <Loader2 className='size-4 animate-spin' />}
            {mode === 'partial'
              ? `Refund ${amountInput ? formatCurrency(parsedAmountCents ?? 0, order.currency) : ''}`
              : `Refund ${formatCurrency(refundableCents, order.currency)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
