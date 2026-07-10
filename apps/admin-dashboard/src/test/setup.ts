import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock next/navigation hooks
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  redirect: vi.fn(),
}));

// Mock next-themes
vi.mock('next-themes', () => ({
  useTheme: () => ({
    theme: 'system',
    setTheme: vi.fn(),
    resolvedTheme: 'light',
  }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock useAdminQuery to bypass React Query provider in tests.
// Calls the fetcher directly and manages state with useState, matching
// the old useAdminData behavior so existing adminApi mocks work as-is.
vi.mock('@/hooks/use-admin-table-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-admin-table-data')>();
  const React = await import('react');
  return {
    ...actual,
    useAdminQuery: (
      queryKey: unknown[],
      fetcher: () => Promise<
        | { ok: true; data: unknown }
        | { ok: false; error: { code: string; message: string; status?: number } }
      >,
      options?: { enabled?: boolean },
    ) => {
      const [data, setData] = React.useState<unknown>(undefined);
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState<
        { code: string; message: string; status?: number } | undefined
      >(undefined);
      const [nonce, setNonce] = React.useState(0);
      const refetchResolvers = React.useRef<Array<() => void>>([]);
      const enabled = options?.enabled ?? true;
      // Serialize query key for dep tracking (JSON.stringify is stable enough for tests)
      const keyStr = JSON.stringify(queryKey);

      React.useEffect(() => {
        if (!enabled) {
          setLoading(false);
          setError(undefined);
          return;
        }
        let cancelled = false;
        setLoading(true);
        setError(undefined);
        fetcher()
          .then((result) => {
            if (cancelled) return;
            if (result.ok) setData(result.data);
            else setError(result.error);
          })
          .catch((e: unknown) => {
            if (!cancelled)
              setError({
                code: 'fetch_error',
                message: e instanceof Error ? e.message : 'Failed to fetch',
              });
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
            const resolvers = refetchResolvers.current.splice(0);
            for (const resolve of resolvers) resolve();
          });
        return () => {
          cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [enabled, nonce, keyStr]);

      return {
        data,
        loading,
        error,
        refetch: () =>
          new Promise<void>((resolve) => {
            refetchResolvers.current.push(resolve);
            setNonce((n) => n + 1);
          }),
      };
    },
  };
});
