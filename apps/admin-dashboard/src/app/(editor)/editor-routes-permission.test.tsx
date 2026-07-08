import * as React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

const permissionGuardMock = vi.hoisted(() => ({
  required: '' as string,
  allowed: true,
}));

const editorViewMocks = vi.hoisted(() => ({
  email: vi.fn(),
  sms: vi.fn(),
  eventPage: vi.fn(),
  contentEditor: vi.fn(),
}));

vi.mock('@/components/permission-guard', () => ({
  PermissionGuard: ({ required, children }: { required: string; children: React.ReactNode }) => {
    permissionGuardMock.required = required;
    return permissionGuardMock.allowed ? <>{children}</> : <div>Access denied</div>;
  },
}));

vi.mock('@/features/content-editor/email-persisted-editor-view', () => ({
  EmailPersistedEditorView: (props: {
    eventId: string;
    returnHref?: string;
    templateKey?: string;
  }) => {
    editorViewMocks.email(props);
    return <div data-testid="email-editor" />;
  },
}));

vi.mock('@/features/content-editor/sms-persisted-editor-view', () => ({
  SmsPersistedEditorView: () => {
    editorViewMocks.sms();
    return <div data-testid="sms-editor" />;
  },
}));

vi.mock('@/features/content-editor/event-page-persisted-editor-view', () => ({
  EventPagePersistedEditorView: () => {
    editorViewMocks.eventPage();
    return <div data-testid="event-page-editor" />;
  },
}));

vi.mock('@/features/content-editor/content-editor-view', () => ({
  ContentEditorView: () => {
    editorViewMocks.contentEditor();
    return <div data-testid="content-editor" />;
  },
}));

import EmailPage from './events/[eventId]/content/email/page';
import SmsPage from './events/[eventId]/content/sms/page';
import EventPageEditorPage from './events/[eventId]/content/event-page/page';
import IMessagePage from './events/[eventId]/content/imessage/page';
import SocialInvitePage from './events/[eventId]/content/social-invite/page';

describe('Editor route permission guards', () => {
  it('email page guards with messages.write', async () => {
    permissionGuardMock.allowed = true;
    render(await EmailPage({ params: Promise.resolve({ eventId: 'evt_1' }) }));
    expect(permissionGuardMock.required).toBe('messages.write');
    expect(editorViewMocks.email).toHaveBeenCalledWith({
      eventId: 'evt_1',
      returnHref: undefined,
      templateKey: undefined,
    });
    expect(screen.getByTestId('email-editor')).toBeInTheDocument();
  });

  it('email page passes a registered template key from search params', async () => {
    permissionGuardMock.allowed = true;
    render(
      await EmailPage({
        params: Promise.resolve({ eventId: 'evt_1' }),
        searchParams: Promise.resolve({ templateKey: 'waitlist-invite' }),
      }),
    );
    expect(editorViewMocks.email).toHaveBeenCalledWith({
      eventId: 'evt_1',
      returnHref: undefined,
      templateKey: 'waitlist-invite',
    });
  });

  it('email page passes a local return href from search params', async () => {
    permissionGuardMock.allowed = true;
    render(
      await EmailPage({
        params: Promise.resolve({ eventId: 'evt_1' }),
        searchParams: Promise.resolve({
          returnTo: '/events/evt_1/messages?tab=lifecycle&templateKey=event-reminder',
          templateKey: 'event-reminder',
        }),
      }),
    );
    expect(editorViewMocks.email).toHaveBeenCalledWith({
      eventId: 'evt_1',
      returnHref: '/events/evt_1/messages?tab=lifecycle&templateKey=event-reminder',
      templateKey: 'event-reminder',
    });
  });

  it('sms page guards with messages.write', async () => {
    permissionGuardMock.allowed = true;
    render(await SmsPage({ params: Promise.resolve({ eventId: 'evt_1' }) }));
    expect(permissionGuardMock.required).toBe('messages.write');
    expect(screen.getByTestId('sms-editor')).toBeInTheDocument();
  });

  it('event-page guards with events.write', async () => {
    permissionGuardMock.allowed = true;
    render(await EventPageEditorPage({ params: Promise.resolve({ eventId: 'evt_1' }) }));
    expect(permissionGuardMock.required).toBe('events.write');
    expect(screen.getByTestId('event-page-editor')).toBeInTheDocument();
  });

  it('imessage page guards with messages.write', async () => {
    permissionGuardMock.allowed = true;
    render(await IMessagePage({ params: Promise.resolve({ eventId: 'evt_1' }) }));
    expect(permissionGuardMock.required).toBe('messages.write');
    expect(screen.getByTestId('content-editor')).toBeInTheDocument();
  });

  it('social-invite page guards with messages.write', async () => {
    permissionGuardMock.allowed = true;
    render(await SocialInvitePage({ params: Promise.resolve({ eventId: 'evt_1' }) }));
    expect(permissionGuardMock.required).toBe('messages.write');
    expect(screen.getByTestId('content-editor')).toBeInTheDocument();
  });

  it('denied users see access denied instead of editor', async () => {
    permissionGuardMock.allowed = false;
    render(await EmailPage({ params: Promise.resolve({ eventId: 'evt_1' }) }));
    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByTestId('email-editor')).not.toBeInTheDocument();
  });
});
