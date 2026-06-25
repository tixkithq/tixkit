import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ConfirmDialog } from './confirm-dialog'

describe('ConfirmDialog', () => {
  it('renders title and description when open', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title='Delete item'
        description='This action cannot be undone.'
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByText('Delete item')).toBeInTheDocument()
    expect(
      screen.getByText('This action cannot be undone.')
    ).toBeInTheDocument()
  })

  it('does not render when closed', () => {
    render(
      <ConfirmDialog
        open={false}
        onOpenChange={vi.fn()}
        title='Delete item'
        onConfirm={vi.fn()}
      />
    )
    expect(screen.queryByText('Delete item')).not.toBeInTheDocument()
  })

  it('calls onConfirm when confirm button is clicked', async () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title='Delete item'
        confirmText='Delete'
        onConfirm={onConfirm}
      />
    )
    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalled()
    })
  })

  it('calls onOpenChange when cancel button is clicked', () => {
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title='Delete item'
        onConfirm={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('Cancel'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows pending state on confirm button', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title='Processing'
        confirmText='Submit'
        pending
        onConfirm={vi.fn()}
      />
    )
    const confirmButton = screen.getByText('Submit').closest('button')
    expect(confirmButton).toBeDisabled()
  })

  it('renders destructive variant', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title='Confirm Revocation'
        confirmText='Revoke Now'
        variant='destructive'
        onConfirm={vi.fn()}
      />
    )
    const confirmButton = screen.getByText('Revoke Now').closest('button')
    expect(confirmButton).toHaveClass('bg-destructive')
  })

  it('supports async onConfirm', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title='Async action'
        confirmText='Go'
        onConfirm={onConfirm}
      />
    )
    fireEvent.click(screen.getByText('Go'))
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalled()
    })
  })
})
