'use client'

import { useState } from 'react'
import { TagIcon, LoaderCircleIcon, CheckCircle2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type Props = {
  initialCode?: string
  disabled: boolean
  applied: boolean
  onApply: (code: string) => void
  onRemove: () => void
  /** When true, the input is rendered as an access code field. */
  accessMode?: boolean
  /** Optional hint shown above the input for access codes. */
  hint?: string
}

export function PromoInput({
  initialCode,
  disabled,
  applied,
  onApply,
  onRemove,
  accessMode = false,
  hint,
}: Props) {
  const [code, setCode] = useState(initialCode ?? '')

  const label = accessMode ? 'Access code' : 'Promo code'
  const placeholder = accessMode ? 'Enter access code' : 'Promo code'

  if (applied) {
    return (
      <div className='flex items-center justify-between gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm dark:border-emerald-900 dark:bg-emerald-950/40'>
        <span className='inline-flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-300'>
          <CheckCircle2Icon className='size-4' />
          {label} {code.trim()} applied
        </span>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          disabled={disabled}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
    )
  }

  return (
    <form
      className='flex flex-col gap-2 sm:flex-row sm:items-start'
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = code.trim()
        if (trimmed) onApply(trimmed)
      }}
    >
      <div className='relative flex-1'>
        <TagIcon className='pointer-events-none absolute inset-y-0 left-3 my-auto size-4 text-muted-foreground' />
        {hint ? (
          <p className='mb-1 text-xs text-muted-foreground'>{hint}</p>
        ) : null}
        <Input
          type='text'
          name={accessMode ? 'accessCode' : 'promoCode'}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={placeholder}
          autoComplete='off'
          disabled={disabled}
          className='pl-9'
          aria-label={label}
        />
      </div>
      <Button
        type='submit'
        variant='outline'
        disabled={disabled || !code.trim()}
        className='gap-1.5'
      >
        {disabled ? (
          <LoaderCircleIcon className='size-4 animate-spin' />
        ) : null}
        Apply
      </Button>
    </form>
  )
}
