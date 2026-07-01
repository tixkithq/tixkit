import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const guardMock = vi.hoisted(() => ({
  allowed: true,
}));

const teamViewMock = vi.hoisted(() => ({
  render: vi.fn(),
}));

vi.mock('@/components/permission-guard', () => ({
  PermissionGuard: ({ children }: { children: React.ReactNode }) =>
    guardMock.allowed ? <>{children}</> : <div>Access denied</div>,
}));

vi.mock('@/features/team/team-view', () => ({
  TeamView: () => {
    teamViewMock.render();
    return <div>Members management</div>;
  },
}));

import Page from './page';

describe('Members settings page', () => {
  beforeEach(() => {
    guardMock.allowed = true;
    teamViewMock.render.mockClear();
  });

  it('does not mount member management when settings permission is denied', () => {
    guardMock.allowed = false;

    render(<Page />);

    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByText('Members management')).not.toBeInTheDocument();
    expect(teamViewMock.render).not.toHaveBeenCalled();
  });

  it('mounts member management when settings permission is allowed', () => {
    render(<Page />);

    expect(screen.getByText('Members management')).toBeInTheDocument();
    expect(teamViewMock.render).toHaveBeenCalledTimes(1);
  });
});
