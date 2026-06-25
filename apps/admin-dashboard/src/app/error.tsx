'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      console.error(error)
    }
  }, [error])

  return (
    <div className='flex min-h-svh flex-col items-center justify-center gap-6 p-8 text-center'>
      <p className='text-5xl font-bold'>500</p>
      <h1 className='text-2xl font-semibold tracking-tight'>
        Something went wrong
      </h1>
      <p className='max-w-md text-muted-foreground'>
        An unexpected error occurred. Try again, and contact support if the
        problem persists.
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  )
}
