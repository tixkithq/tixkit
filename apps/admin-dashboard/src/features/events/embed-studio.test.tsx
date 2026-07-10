import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbedStudio } from './embed-studio';

const useAdminQueryMock = vi.fn();
vi.mock('@/hooks/use-admin-table-data', () => ({
  useAdminQuery: (...args: unknown[]) => useAdminQueryMock(...args),
}));
vi.mock('@/lib/api', () => ({ adminApi: { getEvent: vi.fn() } }));

describe('EmbedStudio', () => {
  beforeEach(() => {
    useAdminQueryMock.mockReturnValue({
      data: { id: 'evt_demo', title: 'Demo Event', brandId: 'brd_demo' },
      loading: false,
      error: undefined,
      refetch: vi.fn(),
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('generates one pinned source of truth and a sandboxed responsive preview', async () => {
    render(<EmbedStudio eventId="evt_demo" />);
    const code = screen.getByLabelText('Generated embed code') as HTMLTextAreaElement;
    expect(code.value).toContain('tixkit-widget-0.1.0.js');
    expect(code.value).toContain('integrity="sha384-');
    expect(code.value).toContain('tixkit:v1:loading');
    const preview = screen.getByTitle('desktop checkout preview');
    expect(preview).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-popups',
    );
    fireEvent.click(screen.getByLabelText('Mobile preview'));
    expect(screen.getByLabelText('Mobile preview')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTitle('mobile checkout preview')).toHaveClass('w-[390px]');
    fireEvent.click(screen.getByRole('button', { name: 'Copy snippet' }));
    await waitFor(() => expect(screen.getByText('Snippet copied.')).toBeInTheDocument());
  });

  it('updates framework output and preserves validated theme tokens', () => {
    render(<EmbedStudio eventId="evt_demo" />);
    fireEvent.change(screen.getByLabelText('Example'), { target: { value: 'react' } });
    fireEvent.change(screen.getByLabelText('Preview theme'), {
      target: { value: 'high-contrast' },
    });
    const code = screen.getByLabelText('Generated embed code') as HTMLTextAreaElement;
    expect(code.value).toContain("import '@tixkit/widget'");
    expect(screen.getByTitle('desktop checkout preview').getAttribute('src')).toContain(
      'theme=high-contrast',
    );
    fireEvent.change(screen.getByLabelText('Font family'), { target: { value: 'Inter' } });
    fireEvent.change(screen.getByLabelText('Button size'), { target: { value: 'lg' } });
    fireEvent.change(screen.getByLabelText('Button variant'), { target: { value: 'outline' } });
    expect(code.value).toContain('fontFamily');
    expect(code.value).toContain('Inter');
    expect(code.value).toContain('buttonSize');
    expect(code.value).toContain('buttonVariant');
  });
});
