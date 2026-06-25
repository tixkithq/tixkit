'use client'

import * as React from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

export type UseTableUrlStateOptions = {
  defaultPageSize?: number
  searchParam?: string
  pageParam?: string
  pageSizeParam?: string
  sortParam?: string
  filters?: string[]
}

const DEFAULTS = {
  defaultPageSize: 10,
  searchParam: 'q',
  pageParam: 'page',
  pageSizeParam: 'per_page',
  sortParam: 'sort',
}

/**
 * Persist table search, sorting, filters, page, and page size in URL query
 * params using Next.js `useSearchParams`/`usePathname`/`useRouter`.
 *
 * History updates are debounced so rapid keystrokes do not flood the browser
 * history stack.
 */
export function useTableUrlState(options: UseTableUrlStateOptions = {}) {
  const {
    defaultPageSize = DEFAULTS.defaultPageSize,
    searchParam = DEFAULTS.searchParam,
    pageParam = DEFAULTS.pageParam,
    pageSizeParam = DEFAULTS.pageSizeParam,
    sortParam = DEFAULTS.sortParam,
    filters = [],
  } = options

  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const search = searchParams.get(searchParam) ?? ''
  const page = parseInt(searchParams.get(pageParam) ?? '1', 10) || 1
  const pageSize =
    parseInt(searchParams.get(pageSizeParam) ?? String(defaultPageSize), 10) ||
    defaultPageSize
  const sort = searchParams.get(sortParam) ?? ''
  const activeFilters = React.useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const f of filters) {
      const val = searchParams.get(f)
      if (val) map[f] = val.split(',')
    }
    return map
  }, [searchParams, filters])

  // Debounce timer ref
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const updateUrl = React.useCallback(
    (updates: Record<string, string | undefined>) => {
      const params = new URLSearchParams(searchParams.toString())
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined || value === '') {
          params.delete(key)
        } else {
          params.set(key, value)
        }
      }
      const qs = params.toString()
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname, searchParams]
  )

  const debouncedUpdateUrl = React.useCallback(
    (updates: Record<string, string | undefined>) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        updateUrl(updates)
      }, 300)
    },
    [updateUrl]
  )

  // Cleanup debounce timer on unmount
  React.useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const setSearch = React.useCallback(
    (value: string) => {
      debouncedUpdateUrl({ [searchParam]: value || undefined, [pageParam]: undefined })
    },
    [debouncedUpdateUrl, searchParam, pageParam]
  )

  const setPage = React.useCallback(
    (p: number) => {
      updateUrl({ [pageParam]: p > 1 ? String(p) : undefined })
    },
    [updateUrl, pageParam]
  )

  const setPageSize = React.useCallback(
    (size: number) => {
      updateUrl({
        [pageSizeParam]: size !== defaultPageSize ? String(size) : undefined,
        [pageParam]: undefined,
      })
    },
    [updateUrl, pageSizeParam, defaultPageSize, pageParam]
  )

  const setSort = React.useCallback(
    (value: string) => {
      updateUrl({ [sortParam]: value || undefined })
    },
    [updateUrl, sortParam]
  )

  const setFilter = React.useCallback(
    (key: string, values: string[]) => {
      updateUrl({ [key]: values.length ? values.join(',') : undefined })
    },
    [updateUrl]
  )

  const reset = React.useCallback(() => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete(searchParam)
    params.delete(pageParam)
    params.delete(pageSizeParam)
    params.delete(sortParam)
    for (const f of filters) params.delete(f)
    const qs = params.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
  }, [router, pathname, searchParams, searchParam, pageParam, pageSizeParam, sortParam, filters])

  return {
    search,
    page,
    pageSize,
    sort,
    filters: activeFilters,
    setSearch,
    setPage,
    setPageSize,
    setSort,
    setFilter,
    reset,
  }
}
