import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMemoryTableState } from '@/components/data-table/stores/memory-adapter';

describe('useMemoryTableState', () => {
  it('starts with empty query by default', () => {
    const { result } = renderHook(() => useMemoryTableState());
    expect(result.current.query).toEqual({});
  });

  it('starts with initial query when provided', () => {
    const initial = { search: 'test', limit: 25 };
    const { result } = renderHook(() => useMemoryTableState(initial));
    expect(result.current.query).toEqual(initial);
  });

  it('setQuery replaces the query', () => {
    const { result } = renderHook(() => useMemoryTableState());
    act(() => {
      result.current.setQuery({ search: 'hello' });
    });
    expect(result.current.query).toEqual({ search: 'hello' });
  });

  it('updateQuery modifies the query immutably', () => {
    const { result } = renderHook(() => useMemoryTableState({ limit: 50 }));
    act(() => {
      result.current.updateQuery((prev) => ({ ...prev, search: 'test' }));
    });
    expect(result.current.query).toEqual({ limit: 50, search: 'test' });
  });

  it('resetFilters clears filters, search, sort, cursor, and direction', () => {
    const { result } = renderHook(() =>
      useMemoryTableState({
        search: 'test',
        sort: [{ field: 'createdAt', direction: 'desc' }],
        filters: { status: { type: 'select', values: ['paid'] } },
        cursor: 'cursor_page_2',
        direction: 'next',
        limit: 50,
      }),
    );
    act(() => {
      result.current.resetFilters();
    });
    expect(result.current.query).toEqual({ limit: 50 });
  });

  it('hasActiveFilters reflects filter state', () => {
    const { result } = renderHook(() => useMemoryTableState());
    expect(result.current.hasActiveFilters).toBe(false);
    act(() => {
      result.current.setQuery({ search: 'test' });
    });
    expect(result.current.hasActiveFilters).toBe(true);
  });
});
