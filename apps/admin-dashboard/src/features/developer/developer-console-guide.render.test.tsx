import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { DeveloperConsoleGuide } from './developer-console-guide';

describe('DeveloperConsoleGuide integration health', () => {
  it('renders independent unavailable states without false zero claims', () => {
    render(<DeveloperConsoleGuide activeKeys={null} activeWebhooks={null} totalWebhooks={null} />);
    expect(screen.getByText('2026-08-20')).toBeInTheDocument();
    expect(screen.getByText('Credential status unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Webhook status unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('No active API key')).not.toBeInTheDocument();
    expect(screen.queryByText(/0 active of 0/)).not.toBeInTheDocument();
  });

  it('distinguishes a successful empty result from an unavailable result', () => {
    render(<DeveloperConsoleGuide activeKeys={0} activeWebhooks={0} totalWebhooks={0} />);
    expect(screen.getByText('No active API key')).toBeInTheDocument();
    expect(screen.getByText('0 active of 0 configured endpoints.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create scoped key' })).toBeInTheDocument();
  });

  it('renders populated key and webhook health', () => {
    render(<DeveloperConsoleGuide activeKeys={2} activeWebhooks={1} totalWebhooks={2} />);
    expect(screen.getByText('2 active API keys')).toBeInTheDocument();
    expect(screen.getByText('1 active of 2 configured endpoints.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage keys' })).toBeInTheDocument();
  });
});
