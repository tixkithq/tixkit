'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'

/**
 * Top loading bar driven by Next App Router pathname changes.
 * Replaces the upstream TanStack Router + react-top-loading-bar variant.
 */
export function NavigationProgress() {
  const pathname = usePathname()
  const [progress, setProgress] = useState(0)
  const [visible, setVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    setVisible(true)
    setProgress(30)

    if (timer.current) clearInterval(timer.current)
    timer.current = setInterval(() => {
      setProgress((p) => {
        if (p >= 90) return p
        return p + Math.random() * 5
      })
    }, 120)

    const stop = setTimeout(() => {
      if (timer.current) clearInterval(timer.current)
      setProgress(100)
      setTimeout(() => setVisible(false), 200)
    }, 250)

    return () => {
      clearTimeout(stop)
      if (timer.current) clearInterval(timer.current)
    }
  }, [pathname])

  if (!visible) return null

  return (
    <div
      className='fixed inset-x-0 top-0 z-[9999] h-0.5 bg-primary transition-[width] duration-200 ease-out'
      style={{ width: `${progress}%` }}
      aria-hidden='true'
    />
  )
}
