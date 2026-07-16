import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const nextThemesProviderMock = vi.hoisted(() =>
  vi.fn(({ children }: { children: ReactNode }) => children),
);

vi.mock('next-themes', () => ({
  ThemeProvider: nextThemesProviderMock,
  useTheme: () => ({ resolvedTheme: 'light', setTheme: vi.fn(), theme: 'system' }),
}));

import { ThemeProvider } from './theme-provider';

describe('ThemeProvider CSP integration', () => {
  it('forwards the request nonce to the next-themes bootstrap script', () => {
    render(
      <ThemeProvider nonce="request-nonce">
        <p>content</p>
      </ThemeProvider>,
    );
    expect(nextThemesProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 'request-nonce' }),
      undefined,
    );
  });
});
