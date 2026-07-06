'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';

type DataTableV2InfiniteScrollProps = {
  hasNextPage: boolean;
  isFetching: boolean;
  onLoadMore: () => void;
  className?: string;
};

/**
 * Sentinel-based infinite scroll trigger.
 *
 * Place at the bottom of a table. When the sentinel enters the viewport,
 * `onLoadMore` is called. Shows a loading spinner while fetching.
 */
export function DataTableV2InfiniteScroll({
  hasNextPage,
  isFetching,
  onLoadMore,
  className,
}: DataTableV2InfiniteScrollProps) {
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetching) {
          onLoadMore();
        }
      },
      { rootMargin: '100px' },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetching, onLoadMore]);

  if (!hasNextPage && !isFetching) return null;

  return (
    <div
      ref={sentinelRef}
      className={className}
      aria-busy={isFetching}
      aria-live="polite"
    >
      {isFetching && (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading more…
        </div>
      )}
    </div>
  );
}
