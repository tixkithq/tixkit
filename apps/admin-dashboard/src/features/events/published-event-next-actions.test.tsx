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
        failedWebhookDeliveryCount={0}
        failedExportCount={0}
        signalState="ready"
        can={() => true}
        onCopyPublicUrl={vi.fn()}
        onRetrySignals={vi.fn()}
      />,
    );

    const items = within(view.getByRole('list', { name: 'Your event is live' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(6);
    expect(items[0]).toHaveTextContent('Recommended nextReview inventory risk');
    expect(items[1]).toHaveTextContent('Prepare check-in');
    expect(items[2]).toHaveTextContent('Review message outcomes');
    expect(items[3]).toHaveTextContent('Open and share the live page');
    expect(items[4]).toHaveTextContent('Monitor sales');
    expect(items[5]).toHaveTextContent('Verify another checkout');
    expect(view.getByRole('link', { name: 'Open review inventory risk' })).toHaveAttribute(
      'href',
      '/events/evt_1/tickets',
    );
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
        failedWebhookDeliveryCount={0}
        failedExportCount={0}
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
    ['checking', 'Checking inventory, messaging, launch, webhook, and export health'],
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
        failedWebhookDeliveryCount={0}
        failedExportCount={0}
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
        failedWebhookDeliveryCount={0}
        failedExportCount={0}
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

  it('prioritizes current webhook and export incidents before routine live-page work', () => {
    const view = render(
      <PublishedEventNextActions
        eventId="evt_1"
        publicUrl="https://tickets.example.test/launch-night"
        lowInventoryCount={0}
        checkInNeedsAttention={false}
        messagingFailureCount={0}
        failedWebhookDeliveryCount={2}
        failedExportCount={1}
        signalState="ready"
        can={() => true}
        onCopyPublicUrl={vi.fn()}
        onRetrySignals={vi.fn()}
      />,
    );

    const items = within(view.getByRole('list', { name: 'Your event is live' })).getAllByRole(
      'listitem',
    );
    expect(items[0]).toHaveTextContent('Recommended nextReview webhook failures');
    expect(items[1]).toHaveTextContent('Retry failed exports');
    expect(view.getByRole('link', { name: 'Open review webhook failures' })).toHaveAttribute(
      'href',
      '/developer/webhooks',
    );
    expect(view.getByRole('link', { name: 'Open retry failed exports' })).toHaveAttribute(
      'href',
      '/events/evt_1/reports',
    );
  });

  it.each([
    [2, 0, 'Review webhook failures'],
    [0, 1, 'Retry failed exports'],
  ] as const)(
    'recommends the single current operational incident (%i webhook, %i export)',
    (failedWebhookDeliveryCount, failedExportCount, expected) => {
      const view = render(
        <PublishedEventNextActions
          eventId="evt_1"
          publicUrl="https://tickets.example.test/launch-night"
          lowInventoryCount={0}
          checkInNeedsAttention={false}
          messagingFailureCount={0}
          failedWebhookDeliveryCount={failedWebhookDeliveryCount}
          failedExportCount={failedExportCount}
          signalState="ready"
          can={() => true}
          onCopyPublicUrl={vi.fn()}
          onRetrySignals={vi.fn()}
        />,
      );

      expect(view.getByText('Recommended next').parentElement).toHaveTextContent(expected);
    },
  );

  it('does not expose operational remediation without the matching permission', () => {
    const view = render(
      <PublishedEventNextActions
        eventId="evt_1"
        publicUrl="https://tickets.example.test/launch-night"
        lowInventoryCount={0}
        checkInNeedsAttention={false}
        messagingFailureCount={0}
        failedWebhookDeliveryCount={2}
        failedExportCount={1}
        signalState="ready"
        can={(permission) => !['developers.write', 'reports.read'].includes(permission)}
        onCopyPublicUrl={vi.fn()}
        onRetrySignals={vi.fn()}
      />,
    );

    expect(view.queryByText('Review webhook failures')).not.toBeInTheDocument();
    expect(view.queryByText('Retry failed exports')).not.toBeInTheDocument();
    expect(view.getByText('Recommended next').parentElement).toHaveTextContent(
      'Open and share the live page',
    );
  });

  it('never truncates a live incident when every incident class needs attention', () => {
    const view = render(
      <PublishedEventNextActions
        eventId="evt_1"
        publicUrl="https://tickets.example.test/launch-night"
        lowInventoryCount={2}
        checkInNeedsAttention
        messagingFailureCount={3}
        failedWebhookDeliveryCount={4}
        failedExportCount={5}
        signalState="ready"
        can={() => true}
        onCopyPublicUrl={vi.fn()}
        onRetrySignals={vi.fn()}
      />,
    );

    const items = within(view.getByRole('list', { name: 'Your event is live' })).getAllByRole(
      'listitem',
    );
    expect(items.slice(0, 5).map((item) => item.querySelector('h3')?.textContent)).toEqual([
      'Review inventory risk',
      'Prepare check-in',
      'Review message outcomes',
      'Review webhook failures',
      'Retry failed exports',
    ]);
  });
});
