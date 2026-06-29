import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { ContentEditorShell } from './shell.js';
import { createContentEditorFixture, fixtureChannelLabel } from './fixtures.js';

describe('ContentEditorShell', () => {
  it('renders the reusable editor regions for an email template', () => {
    const fixture = createContentEditorFixture({ channel: 'email' });

    render(
      <ContentEditorShell
        {...fixture}
        channelLabel={fixtureChannelLabel(fixture.document.channel)}
      />,
    );

    expect(screen.getByTestId('content-editor-shell')).toHaveAttribute('data-channel', 'email');
    expect(screen.getAllByRole('heading', { name: 'Order confirmed' }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Insert blocks')).toBeInTheDocument();
    expect(screen.getByTestId('editor-canvas')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hero' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Variables' })).toBeInTheDocument();
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('opens and closes preview output without losing inspector controls', async () => {
    const fixture = createContentEditorFixture({ channel: 'event_page' });

    render(
      <ContentEditorShell
        {...fixture}
        channelLabel={fixtureChannelLabel(fixture.document.channel)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
    expect(screen.getByTestId('preview-drawer')).toHaveTextContent('Hosted page');
    expect(screen.getByRole('button', { name: 'Versions' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('preview-drawer')).not.toBeInTheDocument();
  });

  it('collapses and reopens the inspector from the top-bar control', () => {
    const fixture = createContentEditorFixture({ channel: 'event_page' });

    render(
      <ContentEditorShell
        {...fixture}
        channelLabel={fixtureChannelLabel(fixture.document.channel)}
      />,
    );

    const closeInspector = screen.getByRole('button', { name: 'Close inspector' });
    closeInspector.focus();
    expect(closeInspector).toHaveFocus();

    fireEvent.click(closeInspector);
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open inspector' }));
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
  });

  it('disables publish and surfaces blockers for invalid drafts', () => {
    const fixture = createContentEditorFixture({ channel: 'email', includeBlockers: true });
    const onPublish = vi.fn();

    render(
      <ContentEditorShell
        {...fixture}
        channelLabel={fixtureChannelLabel(fixture.document.channel)}
        onPublish={onPublish}
      />,
    );

    expect(screen.getByRole('button', { name: 'Resolve publish blockers' })).toBeDisabled();
    expect(screen.getByText('missing_subject')).toBeInTheDocument();
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('renders unavailable future channels as closed states', () => {
    const fixture = createContentEditorFixture({ channel: 'imessage' });

    render(
      <ContentEditorShell
        {...fixture}
        channelLabel={fixtureChannelLabel(fixture.document.channel)}
      />,
    );

    expect(screen.getAllByText('iMessage template').length).toBeGreaterThan(0);
    expect(screen.getByText('Channel unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolve publish blockers' })).toBeDisabled();
  });
});
