'use client'

import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

type ConfirmDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  confirmText?: string
  cancelText?: string
  variant?: 'default' | 'destructive'
  pending?: boolean
  onConfirm: () => void | Promise<void>
  className?: string
  children?: React.ReactNode
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = 'Continue',
  cancelText = 'Cancel',
  variant = 'default',
  pending = false,
  onConfirm,
  className,
  children,
}: ConfirmDialogProps) {
  const [internalPending, setInternalPending] = React.useState(false)
  const isLoading = pending || internalPending

  const handleConfirm = React.useCallback(async () => {
    const result = onConfirm()
    if (result instanceof Promise) {
      setInternalPending(true)
      try {
        await result
      } finally {
        setInternalPending(false)
      }
    }
  }, [onConfirm])

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={cn(className)}>
        <AlertDialogHeader className='text-start'>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && (
            <AlertDialogDescription asChild>
              <div>{description}</div>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>
            {cancelText}
          </AlertDialogCancel>
          <Button
            type='button'
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            disabled={isLoading}
            onClick={handleConfirm}
          >
            {isLoading && <Loader2 className='size-4 animate-spin' />}
            {confirmText}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
