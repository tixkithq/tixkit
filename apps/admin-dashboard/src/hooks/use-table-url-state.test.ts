import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTableUrlState } from './use-table-url-state';

// Mock next/navigation
const mockReplace = vi.fn();
let mockSearchParams = new URLSearchParams();
const mockPathname = '/events';

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  usePathname: () => mockPathname,
  useRouter: () => ({
    replace: mockReplace,
    push: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe('useTableUrlState', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockSearchParams = new URLSearchParams();
  });

  it('returns default values', () => {
    const { result } = renderHook(() => useTableUrlState());
    expect(result.current.search).toBe('');
    expect(result.current.page).toBe(1);
    expect(result.current.pageSize).toBe(10);
    expect(result.current.sort).toBe('');
  });

  it('returns custom default page size', () => {
    const { result } = renderHook(() => useTableUrlState({ defaultPageSize: 20 }));
    expect(result.current.pageSize).toBe(20);
  });

  it('setPage calls router.replace', () => {
    const { result } = renderHook(() => useTableUrlState());
    act(() => {
      result.current.setPage(3);
    });
    expect(mockReplace).toHaveBeenCalled();
  });

  it('setPageSize calls router.replace', () => {
    const { result } = renderHook(() => useTableUrlState());
    act(() => {
      result.current.setPageSize(50);
    });
    expect(mockReplace).toHaveBeenCalled();
  });

  it('setSearch is debounced', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTableUrlState());
    act(() => {
      result.current.setSearch('test');
    });
    // Should not have called replace yet (debounced)
    expect(mockReplace).not.toHaveBeenCalled();
    // Fast-forward debounce
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(mockReplace).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('reset clears all params', () => {
    const { result } = renderHook(() => useTableUrlState());
    act(() => {
      result.current.reset();
    });
    expect(mockReplace).toHaveBeenCalled();
    const lastCall = mockReplace.mock.calls[mockReplace.mock.calls.length - 1];
    expect(lastCall[0]).toBe('/events');
  });

  it('reads filters from search params', () => {
    mockSearchParams = new URLSearchParams();
    mockSearchParams.set('status', 'draft,published');
    const { result } = renderHook(() => useTableUrlState({ filters: ['status'] }));
    expect(result.current.filters.status).toEqual(['draft', 'published']);
  });
});
