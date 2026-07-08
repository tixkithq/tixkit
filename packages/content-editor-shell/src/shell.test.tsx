import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { EditorChrome, EditorLeftRail } from './chrome.js';
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
    expect(screen.getByRole('complementary', { name: 'Insert content' })).toBeInTheDocument();
    expect(screen.getByTestId('editor-canvas')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Insert Hero' })).toBeInTheDocument();
    expect(screen.getByText('Two general admission tickets')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Variables' })).toBeInTheDocument();
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('fires compact insert rail actions with accessible button names', () => {
    const fixture = createContentEditorFixture({ channel: 'email' });
    const onInsertAction = vi.fn();

    render(
      <ContentEditorShell
        {...fixture}
        channelLabel={fixtureChannelLabel(fixture.document.channel)}
        onInsertAction={onInsertAction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Insert Hero' }));
    fireEvent.click(screen.getByRole('button', { name: 'Insert Ticket summary' }));

    expect(onInsertAction).toHaveBeenNthCalledWith(1, 'hero');
    expect(onInsertAction).toHaveBeenNthCalledWith(2, 'ticket-summary');
  });

  it('keeps insert tools near the top of the left rail', () => {
    render(
      <EditorLeftRail
        hiddenModes={{ code: true, editor: true, preview: true }}
        inserts={
          <>
            <button type="button">Insert block</button>
            <button type="button">Insert theme</button>
          </>
        }
        mode="editor"
        onModeChange={vi.fn()}
      />,
    );

    const rail = screen.getByRole('navigation', { name: 'Editor tools' });
    expect(rail).toHaveTextContent('Insert blockInsert theme');
  });

  it('renders host inspector modes for content page body theme code variables history and issues', () => {
    const fixture = createContentEditorFixture({ channel: 'email' });
    const onPanelChange = vi.fn();
    const panels = [
      'Content',
      'Page',
      'Body',
      'Theme',
      'Code',
      'Variables',
      'History',
      'Issues',
    ].map((label) => ({
      id: label === 'Content' ? 'block' : label.toLowerCase(),
      label,
      content: <section>{label} panel</section>,
    }));

    render(
      <ContentEditorShell
        {...fixture}
        activeInspectorPanelId="block"
        channelLabel={fixtureChannelLabel(fixture.document.channel)}
        inspectorPanels={panels}
        onInspectorPanelChange={onPanelChange}
      />,
    );

    for (const panel of panels) {
      expect(screen.getByRole('button', { name: panel.label })).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(onPanelChange).toHaveBeenCalledWith('code');
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

  it('keeps inspector content available as a mobile bottom sheet', () => {
    render(
      <EditorChrome
        canvas={<main>Canvas</main>}
        channel="event_page"
        inspector={<section>Inspector content</section>}
        leftRail={<nav aria-label="Editor tools">Tools</nav>}
        topBar={<header>Top bar</header>}
      />,
    );

    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(inspector).not.toHaveClass('hidden');
    expect(inspector).toHaveClass(
      'fixed',
      'inset-x-0',
      'bottom-0',
      'h-[min(78svh,42rem)]',
      'lg:static',
      'lg:w-80',
    );
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

  it('can disable only test-send while leaving publish available', () => {
    const fixture = createContentEditorFixture({ channel: 'event_page' });
    const onPublish = vi.fn();
    const onTestSend = vi.fn();

    render(
      <ContentEditorShell
        {...fixture}
        channelLabel={fixtureChannelLabel(fixture.document.channel)}
        testSendUnavailableReason="Hosted pages use preview instead of test sends."
        onPublish={onPublish}
        onTestSend={onTestSend}
      />,
    );

    expect(screen.getByRole('button', { name: 'Test send unavailable' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onTestSend).not.toHaveBeenCalled();
  });

  it('fires duplicate and archive actions from the More actions menu', () => {
    const fixture = createContentEditorFixture({ channel: 'email' });
    const onDuplicate = vi.fn();
    const onArchive = vi.fn();

    render(
      <ContentEditorShell
        {...fixture}
        channelLabel={fixtureChannelLabel(fixture.document.channel)}
        onArchive={onArchive}
        onDuplicate={onDuplicate}
      />,
    );

    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate template' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive template' }));

    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onArchive).toHaveBeenCalledTimes(1);
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

  it('fails closed when document canvas content is not explicit', () => {
    const fixture = createContentEditorFixture({ channel: 'email' });

    expect(() =>
      render(
        <ContentEditorShell
          {...fixture}
          canvasBlocks={
            [
              {
                id: 'legacy-summary-only',
                label: 'Legacy summary-only content',
                summary: 'This must not render through a fallback shell.',
              },
            ] as unknown as typeof fixture.canvasBlocks
          }
          channelLabel={fixtureChannelLabel(fixture.document.channel)}
        />,
      ),
    ).toThrow('Document canvas block must render document content: legacy-summary-only');
  });

  it('renders document canvases without visible block-selection chrome', () => {
    const fixture = createContentEditorFixture({ channel: 'event_page' });

    render(
      <ContentEditorShell
        {...fixture}
        channelLabel={fixtureChannelLabel(fixture.document.channel)}
      />,
    );

    expect(screen.getByTestId('editor-canvas')).toHaveAttribute(
      'aria-label',
      'All Access Chicago editable document',
    );
    expect(screen.getByRole('region', { name: 'Editable document region 1' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Select content region/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Selected' })).not.toBeInTheDocument();
  });
});
