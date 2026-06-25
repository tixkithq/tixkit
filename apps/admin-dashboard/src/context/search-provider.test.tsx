import { describe, expect, it, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { SearchProvider, useSearch } from './search-provider'

// Mock CommandMenu to avoid needing ThemeProvider
vi.mock('@/components/command-menu', () => ({
  CommandMenu: () => null,
}))

function TestConsumer() {
  const { open, setOpen } = useSearch()
  return (
    <div>
      <span data-testid='open-state'>{String(open)}</span>
      <button onClick={() => setOpen(true)}>Open</button>
      <button onClick={() => setOpen(false)}>Close</button>
      <button onClick={() => setOpen((prev) => !prev)}>Toggle</button>
    </div>
  )
}

describe('SearchProvider', () => {
  it('provides initial closed state', () => {
    render(
      <SearchProvider>
        <TestConsumer />
      </SearchProvider>
    )
    expect(screen.getByTestId('open-state').textContent).toBe('false')
  })

  it('allows setting open state to true', () => {
    render(
      <SearchProvider>
        <TestConsumer />
      </SearchProvider>
    )
    act(() => {
      screen.getByText('Open').click()
    })
    expect(screen.getByTestId('open-state').textContent).toBe('true')
  })

  it('allows toggling open state', () => {
    render(
      <SearchProvider>
        <TestConsumer />
      </SearchProvider>
    )
    act(() => {
      screen.getByText('Toggle').click()
    })
    expect(screen.getByTestId('open-state').textContent).toBe('true')
    act(() => {
      screen.getByText('Toggle').click()
    })
    expect(screen.getByTestId('open-state').textContent).toBe('false')
  })

  it('throws when useSearch is used outside provider', () => {
    // Suppress console.error for this test
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<TestConsumer />)).toThrow(
      'useSearch has to be used within SearchProvider'
    )
    spy.mockRestore()
  })
})
