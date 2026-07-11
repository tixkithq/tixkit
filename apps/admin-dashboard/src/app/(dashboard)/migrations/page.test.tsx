import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Page from './page';

vi.mock('@/components/permission-guard', () => ({
  PermissionGuard: ({ required, children }: { required: string; children: React.ReactNode }) => (
    <div data-required={required}>{children}</div>
  ),
}));
vi.mock('@/features/migrations/migration-workspace', () => ({
  MigrationWorkspace: () => <div>Migration workspace content</div>,
}));

describe('migrations page', () => {
  it('guards the workspace with migrations.read', () => {
    const { container } = render(<Page />);
    expect(screen.getByText('Migration workspace content')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('data-required', 'migrations.read');
  });
});
