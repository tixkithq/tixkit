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
  MessagesView: () => {
    messagesViewMock();
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
  it('requires messages.write before mounting the global messages view', () => {
    const view = render(<Page />);

    expect(permissionGuardMock).toHaveBeenCalledWith('messages.write');
    expect(messagesViewMock).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('permission-guard-messages.write')).toBeInTheDocument();
    expect(view.getByTestId('messages-view')).toBeInTheDocument();
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
