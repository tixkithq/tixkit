import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = vi.hoisted(() => ({
  clerkEnabled: true,
}));

const userMock = vi.hoisted(() => ({
  value: {
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    imageUrl: 'https://images.example.test/ada.png',
  },
}));

vi.mock('@/lib/auth', () => ({
  hasClerkKey: () => authMock.clerkEnabled,
}));

vi.mock('@/context/admin-user-provider', () => ({
  useAdminUser: () => userMock.value,
}));

import ProfilePage from './page';

describe('ProfilePage', () => {
  beforeEach(() => {
    authMock.clerkEnabled = true;
    userMock.value = {
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      imageUrl: 'https://images.example.test/ada.png',
    };
    vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  it('routes avatar and profile edits to Clerk instead of a local-only upload', () => {
    render(<ProfilePage />);

    expect(screen.getByText('Profile')).toBeInTheDocument();
    expect(screen.getByText('AL')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@example.test')).toBeInTheDocument();
    expect(screen.queryByText('Upload Avatar')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/profile-avatar-upload/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Uploaded avatar artifact/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Manage Profile in Clerk' }));
    expect(window.open).toHaveBeenCalledWith('/user', '_blank');
  });

  it('keeps profile changes gated when Clerk profile management is unavailable', () => {
    authMock.clerkEnabled = false;

    render(<ProfilePage />);

    expect(screen.queryByRole('button', { name: /Manage.*Clerk/i })).not.toBeInTheDocument();
    expect(screen.getByText('Save Changes')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Profile changes are gated because Clerk authentication or a profile update endpoint is not configured.',
      ),
    ).toBeInTheDocument();
  });
});
