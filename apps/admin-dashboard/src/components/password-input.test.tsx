import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PasswordInput } from './password-input';

describe('PasswordInput', () => {
  it('renders an input with type password by default', () => {
    render(<PasswordInput />);
    const input = document.querySelector('input');
    expect(input).toHaveAttribute('type', 'password');
  });

  it('toggles password visibility when eye button is clicked', () => {
    render(<PasswordInput />);
    const input = document.querySelector('input')!;
    expect(input).toHaveAttribute('type', 'password');

    const toggleButton = screen.getByRole('button', {
      name: /show password/i,
    });
    fireEvent.click(toggleButton);
    expect(input).toHaveAttribute('type', 'text');

    const hideButton = screen.getByRole('button', {
      name: /hide password/i,
    });
    fireEvent.click(hideButton);
    expect(input).toHaveAttribute('type', 'password');
  });

  it('passes through props to the input', () => {
    render(<PasswordInput placeholder="Enter password" disabled />);
    const input = document.querySelector('input')!;
    expect(input).toHaveAttribute('placeholder', 'Enter password');
    expect(input).toBeDisabled();
  });
});
