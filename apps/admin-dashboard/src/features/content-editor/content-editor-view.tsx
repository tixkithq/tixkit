'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { ContentEditorShell } from '@tixkit/content-editor-shell';
import type { ContentEditorPreview } from '@tixkit/content-editor-shell';
import { createContentEditorRouteFixture, type ContentEditorRouteKind } from './fixture-adapters';

export function ContentEditorView({
  actionsUnavailableReason,
  eventId,
  kind,
  preview,
}: {
  actionsUnavailableReason?: string;
  eventId: string;
  kind: ContentEditorRouteKind;
  preview?: ContentEditorPreview;
}) {
  const [autosave, setAutosave] = React.useState<'saved' | 'saving' | 'error'>('saved');
  const fixture = createContentEditorRouteFixture(kind, {
    actionsUnavailableReason,
    eventId,
    autosave,
    preview,
  });

  const unavailable = () => {
    setAutosave('error');
    toast.error('Channel adapter not connected yet');
  };

  return React.createElement(
    'div',
    { className: 'space-y-4' },
    React.createElement(
      'div',
      { className: 'flex flex-wrap items-center justify-between gap-3' },
      React.createElement(
        'div',
        { className: 'min-w-0 space-y-1' },
        React.createElement(
          'h1',
          { className: 'truncate text-2xl font-bold tracking-tight' },
          fixture.routeTitle,
        ),
        React.createElement(
          'p',
          { className: 'max-w-3xl text-sm text-muted-foreground' },
          fixture.routeDescription,
        ),
      ),
    ),
    React.createElement(ContentEditorShell, {
      autosave: fixture.autosave,
      canvasBlocks: fixture.canvasBlocks,
      channelLabel: fixture.channelLabel,
      document: fixture.document,
      draft: fixture.draft,
      insertActions: fixture.insertActions,
      preview: fixture.preview,
      testSendUnavailableReason: fixture.actionsUnavailableReason,
      unavailableReason: fixture.unavailableReason,
      versions: fixture.versions,
      onArchive: unavailable,
      onPublish: unavailable,
      onTestSend: unavailable,
    }),
  );
}
