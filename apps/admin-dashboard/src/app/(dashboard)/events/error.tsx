'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

export default function Error({
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
    <div className='flex min-h-[50svh] flex-col items-center justify-center gap-4 text-center'>
      <h2 className='text-xl font-semibold'>Failed to load events</h2>
      <p className='max-w-md text-sm text-muted-foreground'>
        {error.message || 'An unexpected error occurred while loading events.'}
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  )
}
