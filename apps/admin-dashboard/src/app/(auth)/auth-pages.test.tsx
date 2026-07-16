import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@/lib/routes';

const mocks = vi.hoisted(() => ({
  hasClerkKey: vi.fn(),
  usesLocalDevAuth: vi.fn(),
  redirect: vi.fn(),
  signInProps: vi.fn(),
  signUpProps: vi.fn(),
}));

vi.mock('@/lib/auth-server', () => ({
  hasClerkKey: mocks.hasClerkKey,
  usesLocalDevAuth: mocks.usesLocalDevAuth,
}));

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}));

vi.mock('@clerk/nextjs', () => ({
  SignIn: (props: Record<string, unknown>) => {
    mocks.signInProps(props);
    return <div data-testid="clerk-sign-in" />;
  },
  SignUp: (props: Record<string, unknown>) => {
    mocks.signUpProps(props);
    return <div data-testid="clerk-sign-up" />;
  },
}));

import SignInPage from './sign-in/[[...sign-in]]/page';
import SignUpPage from './sign-up/[[...sign-up]]/page';

describe('admin auth pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasClerkKey.mockReturnValue(true);
    mocks.usesLocalDevAuth.mockReturnValue(false);
    mocks.redirect.mockImplementation((url: string) => {
      throw new Error(`redirect:${url}`);
    });
  });

  it('sends successful sign-ins directly to the dashboard', () => {
    render(<SignInPage />);

    expect(screen.getByTestId('clerk-sign-in')).toBeInTheDocument();
    expect(mocks.signInProps).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackRedirectUrl: routes.dashboard,
        forceRedirectUrl: routes.dashboard,
        signUpFallbackRedirectUrl: routes.dashboard,
        signUpForceRedirectUrl: routes.dashboard,
      }),
    );
  });

  it('sends successful sign-ups directly to the dashboard', () => {
    render(<SignUpPage />);

    expect(screen.getByTestId('clerk-sign-up')).toBeInTheDocument();
    expect(mocks.signUpProps).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackRedirectUrl: routes.dashboard,
        signInFallbackRedirectUrl: routes.dashboard,
      }),
    );
    expect(mocks.signUpProps).toHaveBeenCalledWith(
      expect.not.objectContaining({
        forceRedirectUrl: expect.anything(),
        signInForceRedirectUrl: expect.anything(),
      }),
    );
  });

  it('redirects the local no-Clerk sign-in page to the dashboard without rendering Clerk', () => {
    mocks.hasClerkKey.mockReturnValue(false);
    mocks.usesLocalDevAuth.mockReturnValue(true);

    expect(() => render(<SignInPage />)).toThrow(`redirect:${routes.dashboard}`);

    expect(mocks.redirect).toHaveBeenCalledWith(routes.dashboard);
    expect(mocks.signInProps).not.toHaveBeenCalled();
  });

  it('redirects the local no-Clerk sign-up page to the dashboard without rendering Clerk', () => {
    mocks.hasClerkKey.mockReturnValue(false);
    mocks.usesLocalDevAuth.mockReturnValue(true);

    expect(() => render(<SignUpPage />)).toThrow(`redirect:${routes.dashboard}`);

    expect(mocks.redirect).toHaveBeenCalledWith(routes.dashboard);
    expect(mocks.signUpProps).not.toHaveBeenCalled();
  });

  it('fails closed instead of redirecting sign-in to the dashboard when Clerk is misconfigured', () => {
    mocks.hasClerkKey.mockReturnValue(false);

    render(<SignInPage />);

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.signInProps).not.toHaveBeenCalled();
    expect(screen.getByText('Admin sign-in is not configured')).toBeInTheDocument();
  });

  it('fails closed instead of redirecting sign-up to the dashboard when Clerk is misconfigured', () => {
    mocks.hasClerkKey.mockReturnValue(false);

    render(<SignUpPage />);

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.signUpProps).not.toHaveBeenCalled();
    expect(screen.getByText('Admin sign-up is not configured')).toBeInTheDocument();
  });
});
