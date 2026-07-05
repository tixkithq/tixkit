'use client';

import * as React from 'react';

/**
 * Debounces a rapidly-changing value (e.g. a search input) and only
 * emits the latest value after `delayMs` has elapsed without changes.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
