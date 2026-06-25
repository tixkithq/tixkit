import { describe, expect, it } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { LayoutProvider, useLayout, type Collapsible, type SidebarVariant } from './layout-provider'

function TestConsumer() {
  const { collapsible, variant, setCollapsible, setVariant, resetLayout } = useLayout()
  return (
    <div>
      <span data-testid='collapsible'>{collapsible}</span>
      <span data-testid='variant'>{variant}</span>
      <button onClick={() => setCollapsible('offcanvas' as Collapsible)}>
        Set Offcanvas
      </button>
      <button onClick={() => setVariant('floating' as SidebarVariant)}>
        Set Floating
      </button>
      <button onClick={resetLayout}>Reset</button>
    </div>
  )
}

describe('LayoutProvider', () => {
  it('provides default values', () => {
    render(
      <LayoutProvider>
        <TestConsumer />
      </LayoutProvider>
    )
    expect(screen.getByTestId('collapsible').textContent).toBe('icon')
    expect(screen.getByTestId('variant').textContent).toBe('inset')
  })

  it('allows changing collapsible', () => {
    render(
      <LayoutProvider>
        <TestConsumer />
      </LayoutProvider>
    )
    act(() => {
      screen.getByText('Set Offcanvas').click()
    })
    expect(screen.getByTestId('collapsible').textContent).toBe('offcanvas')
  })

  it('allows changing variant', () => {
    render(
      <LayoutProvider>
        <TestConsumer />
      </LayoutProvider>
    )
    act(() => {
      screen.getByText('Set Floating').click()
    })
    expect(screen.getByTestId('variant').textContent).toBe('floating')
  })

  it('resetLayout restores defaults', () => {
    render(
      <LayoutProvider>
        <TestConsumer />
      </LayoutProvider>
    )
    act(() => {
      screen.getByText('Set Offcanvas').click()
      screen.getByText('Set Floating').click()
    })
    act(() => {
      screen.getByText('Reset').click()
    })
    expect(screen.getByTestId('collapsible').textContent).toBe('icon')
    expect(screen.getByTestId('variant').textContent).toBe('inset')
  })
})
