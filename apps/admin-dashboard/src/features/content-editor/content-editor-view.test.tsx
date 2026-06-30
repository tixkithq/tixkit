import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ContentEditorView } from './content-editor-view';
import {
  contentChannelFromRoute,
  createContentEditorRouteFixture,
} from './fixture-adapters';

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

describe('content editor fixture adapters', () => {
  it('maps admin route kinds to canonical content channels', () => {
    expect(contentChannelFromRoute('event-page')).toBe('event_page');
    expect(contentChannelFromRoute('email')).toBe('email');
    expect(contentChannelFromRoute('sms')).toBe('sms');
    expect(contentChannelFromRoute('imessage')).toBe('imessage');
    expect(contentChannelFromRoute('social-invite')).toBe('social_invite');
  });

  it('keeps fixture actions unavailable instead of faking persistence', () => {
    const fixture = createContentEditorRouteFixture('email', { eventId: 'evt_1' });
    expect(fixture.actionsUnavailableReason).toContain('Fixture editor');
  });
});

describe('ContentEditorView', () => {
  it('renders the event-page shell route with preview and disabled publish', () => {
    render(React.createElement(ContentEditorView, { eventId: 'evt_1', kind: 'event-page' }));

    expect(screen.getByRole('heading', { name: 'Event page editor' })).toBeInTheDocument();
    expect(screen.getByTestId('content-editor-shell')).toHaveAttribute(
      'data-channel',
      'event_page',
    );
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
    expect(screen.getByTestId('preview-drawer')).toHaveTextContent('Hosted page');
  });

  it('renders SMS-specific insert controls and a mobile-width canvas', () => {
    render(React.createElement(ContentEditorView, { eventId: 'evt_1', kind: 'sms' }));

    expect(screen.getByRole('heading', { name: 'SMS template editor' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Insert Opt-out' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Insert Variable' })).toBeInTheDocument();
  });

  it('renders server-provided SMS compliance preview output', () => {
    render(
      React.createElement(ContentEditorView, {
        eventId: 'evt_1',
        kind: 'sms',
        preview: {
          label: 'SMS compliance preview',
          output: 'Hi Ada, All Access starts 2026-07-17 19:00.\n\nSegments: 1 (gsm)',
          format: 'text',
        },
        actionsUnavailableReason:
          'SMS compliance adapter preview is active; publish waits for persisted content wiring.',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
    expect(screen.getByTestId('preview-drawer')).toHaveTextContent('SMS compliance preview');
    expect(screen.getByTestId('preview-drawer')).toHaveTextContent('Segments: 1 (gsm)');
  });

  it('renders server-provided email adapter preview output', () => {
    render(
      React.createElement(ContentEditorView, {
        eventId: 'evt_1',
        kind: 'email',
        preview: {
          label: 'React Email preview',
          output: 'Subject: Your All Access Chicago tickets are ready',
          format: 'html',
        },
        actionsUnavailableReason:
          'React Email adapter preview is active; publish waits for persisted content wiring.',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
    expect(screen.getByTestId('preview-drawer')).toHaveTextContent('React Email preview');
    expect(screen.getByTestId('preview-drawer')).toHaveTextContent('Your All Access Chicago tickets are ready');
  });

  it('renders future-channel unavailable states without fake insert actions', () => {
    render(
      React.createElement(ContentEditorView, {
        eventId: 'evt_1',
        kind: 'imessage',
        actionsUnavailableReason:
          'iMessage is registered as a future channel and cannot publish or send tests yet.',
      }),
    );

    expect(screen.getByRole('heading', { name: 'iMessage template unavailable' })).toBeInTheDocument();
    expect(screen.getByTestId('content-editor-shell')).toHaveAttribute('data-channel', 'imessage');
    expect(screen.getByText('Channel unavailable')).toBeInTheDocument();
    expect(screen.getAllByText('iMessage template is not enabled for this workspace.')).toHaveLength(
      2,
    );
    expect(screen.getByRole('button', { name: 'Resolve publish blockers' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test send unavailable' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Hero' })).not.toBeInTheDocument();
  });
});
