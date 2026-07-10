import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Page from './page';
import EventMessagesPage from '../events/[eventId]/messages/page';

const permissionGuardMock = vi.hoisted(() => vi.fn());
const messagesViewMock = vi.hoisted(() => vi.fn());
const eventMessagesViewMock = vi.hoisted(() => vi.fn());

vi.mock('@/components/permission-guard', () => ({
  PermissionGuard: ({ required, children }: { required: string; children: React.ReactNode }) => {
    permissionGuardMock(required);
    return <section data-testid={`permission-guard-${required}`}>{children}</section>;
  },
}));

vi.mock('@/features/messages/messages-view', () => ({
  MessagesView: (props: Record<string, unknown>) => {
    messagesViewMock(props);
    return <div data-testid="messages-view" />;
  },
}));

vi.mock('@/features/events/event-messages-view', () => ({
  EventMessagesView: ({ eventId }: { eventId: string }) => {
    eventMessagesViewMock(eventId);
    return <div data-testid="event-messages-view" />;
  },
}));

describe('Messages route permission guards', () => {
  it('requires messages.write before mounting the global messages view', async () => {
    const element = await Page({});
    const view = render(element);

    expect(permissionGuardMock).toHaveBeenCalledWith('messages.write');
    expect(messagesViewMock).toHaveBeenCalledWith({
      initialEventId: undefined,
      initialLifecycleTemplateKey: undefined,
      initialTab: 'campaigns',
    });
    expect(view.getByTestId('permission-guard-messages.write')).toBeInTheDocument();
    expect(view.getByTestId('messages-view')).toBeInTheDocument();
  });

  it('deep-links the global view to a lifecycle template and event', async () => {
    const element = await Page({
      searchParams: Promise.resolve({
        eventId: 'evt_1',
        tab: 'lifecycle',
        templateKey: 'tickets-issued',
      }),
    });
    render(element);

    expect(messagesViewMock).toHaveBeenCalledWith({
      initialEventId: 'evt_1',
      initialLifecycleTemplateKey: 'tickets-issued',
      initialTab: 'lifecycle',
    });
  });

  it('requires messages.write before mounting the event messages view', async () => {
    const element = await EventMessagesPage({
      params: Promise.resolve({ eventId: 'evt_1' }),
    });

    const view = render(element);

    expect(permissionGuardMock).toHaveBeenCalledWith('messages.write');
    expect(eventMessagesViewMock).toHaveBeenCalledWith('evt_1');
    expect(view.getByTestId('permission-guard-messages.write')).toBeInTheDocument();
    expect(view.getByTestId('event-messages-view')).toBeInTheDocument();
  });
});
