import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { GatedControl } from './gated-control';

describe('GatedControl', () => {
  it('keeps gated actions focusable with an accessible rationale', () => {
    render(
      <GatedControl reason="Invoice downloads need an invoice API endpoint.">
        Download Invoices
      </GatedControl>,
    );

    const button = screen.getByRole('button', { name: /download invoices/i });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('data-gated-control', 'true');

    const descriptionId = button.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId!)).toHaveTextContent(
      'Invoice downloads need an invoice API endpoint.',
    );
  });

  it('does not activate mouse or keyboard actions', () => {
    const onClick = vi.fn();
    render(
      <GatedControl reason="Profile updates need a profile API endpoint." onClick={onClick}>
        Save Changes
      </GatedControl>,
    );

    const button = screen.getByRole('button', { name: /save changes/i });
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.keyDown(button, { key: ' ' });

    expect(onClick).not.toHaveBeenCalled();
  });
});
