import { fireEvent, render, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { Permission } from '@tixkit/domain';
import { describe, expect, it, vi } from 'vitest';
import { PublishedEventNextActions } from './published-event-next-actions';

describe('PublishedEventNextActions', () => {
  it('prioritizes actionable live incidents before sharing and monitoring work', () => {
    const view = render(
      <PublishedEventNextActions
        eventId="evt_1"
        publicUrl="https://tickets.example.test/launch-night"
        lowInventoryCount={2}
        checkInNeedsAttention
        messagingFailureCount={3}
        signalState="ready"
        can={() => true}
        onCopyPublicUrl={vi.fn()}
        onRetrySignals={vi.fn()}
      />,
    );

    const items = within(view.getByRole('list', { name: 'Your event is live' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('Recommended nextReview inventory risk');
    expect(items[1]).toHaveTextContent('Prepare check-in');
    expect(items[2]).toHaveTextContent('Review message outcomes');
    expect(items[3]).toHaveTextContent('Open and share the live page');
    expect(view.getByRole('link', { name: 'Open review inventory risk' })).toHaveAttribute(
      'href',
      '/events/evt_1/tickets',
    );
    expect(view.queryByText('Monitor sales')).not.toBeInTheDocument();
  });

  it('keeps public-link actions safe for a read-only organizer', () => {
    const copy = vi.fn();
    const view = render(
      <PublishedEventNextActions
        eventId="evt_1"
        publicUrl="https://tickets.example.test/launch-night"
        lowInventoryCount={2}
        checkInNeedsAttention
        messagingFailureCount={3}
        signalState="ready"
        can={(_permission: Permission) => false}
        onCopyPublicUrl={copy}
        onRetrySignals={vi.fn()}
      />,
    );

    expect(view.getAllByRole('listitem')).toHaveLength(1);
    expect(view.queryByText('Review inventory risk')).not.toBeInTheDocument();
    expect(view.queryByText('Prepare check-in')).not.toBeInTheDocument();
    expect(view.queryByText('Review message outcomes')).not.toBeInTheDocument();
    expect(view.getByRole('link', { name: /Open public page/ })).toHaveAttribute(
      'href',
      'https://tickets.example.test/launch-night',
    );
    fireEvent.click(view.getByRole('button', { name: 'Copy public link' }));
    expect(copy).toHaveBeenCalledOnce();
  });

  it.each([
    ['checking', 'Checking inventory, messaging, and launch health'],
    ['incomplete', 'Health checks are incomplete'],
    ['unavailable', 'Action priority is unavailable'],
  ] as const)('does not recommend an action while live signals are %s', (signalState, notice) => {
    const retrySignals = vi.fn();
    const view = render(
      <PublishedEventNextActions
        eventId="evt_1"
        publicUrl="https://tickets.example.test/launch-night"
        lowInventoryCount={0}
        checkInNeedsAttention={false}
        messagingFailureCount={0}
        signalState={signalState}
        can={() => true}
        onCopyPublicUrl={vi.fn()}
        onRetrySignals={retrySignals}
      />,
    );

    expect(view.getByText(new RegExp(notice))).toBeInTheDocument();
    expect(view.queryByText('Recommended next')).not.toBeInTheDocument();
    expect(view.getByText('Option 1')).toBeInTheDocument();
    if (signalState === 'incomplete') {
      fireEvent.click(view.getByRole('button', { name: 'Retry health checks' }));
      expect(retrySignals).toHaveBeenCalledOnce();
    }
  });

  it('exposes semantic headings, new-tab context, and a selectable canonical URL', () => {
    const view = render(
      <PublishedEventNextActions
        eventId="evt_1"
        publicUrl="https://tickets.example.test/launch-night"
        lowInventoryCount={0}
        checkInNeedsAttention={false}
        messagingFailureCount={0}
        signalState="ready"
        can={() => false}
        onCopyPublicUrl={vi.fn()}
        onRetrySignals={vi.fn()}
      />,
    );

    expect(view.getByRole('heading', { level: 2, name: 'Your event is live' })).toBeInTheDocument();
    expect(
      view.getByRole('heading', {
        level: 3,
        name: 'Open and share the live page',
      }),
    ).toBeInTheDocument();
    expect(view.getByRole('link', { name: /opens in a new tab/ })).toHaveAttribute(
      'target',
      '_blank',
    );
    const publicUrl = view.getByRole('textbox', { name: 'Public event URL' });
    expect(publicUrl).toHaveValue('https://tickets.example.test/launch-night');
    publicUrl.focus();
    expect(publicUrl).toHaveFocus();
  });
});
