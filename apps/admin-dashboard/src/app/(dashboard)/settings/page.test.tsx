import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import SettingsPage from './page'

describe('SettingsPage', () => {
  it('uses workspace and members terminology with canonical settings routes', () => {
    render(<SettingsPage />)

    expect(screen.getByRole('link', { name: /Workspace/ })).toHaveAttribute(
      'href',
      '/settings/workspace',
    )
    expect(screen.getByRole('link', { name: /Members/ })).toHaveAttribute(
      'href',
      '/settings/members',
    )
    expect(screen.queryByRole('link', { name: /Organization/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Team/ })).not.toBeInTheDocument()
  })
})
