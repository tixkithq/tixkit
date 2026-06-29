import {
  createContentEditorFixture,
  fixtureChannelLabel,
  type ContentEditorAutosaveState,
  type ContentEditorPreview,
} from '@tixkit/content-editor-shell';
import type { ContentChannel } from '@tixkit/content-core';

export type ContentEditorRouteKind = 'event-page' | 'email' | 'sms';

export type ContentEditorFixtureAdapter = ReturnType<typeof createContentEditorFixture> & {
  channelLabel: string;
  routeTitle: string;
  routeDescription: string;
  actionsUnavailableReason: string;
};

export function contentChannelFromRoute(kind: ContentEditorRouteKind): ContentChannel {
  switch (kind) {
    case 'event-page':
      return 'event_page';
    case 'email':
      return 'email';
    case 'sms':
      return 'sms';
  }
}

export function createContentEditorRouteFixture(
  kind: ContentEditorRouteKind,
  options: {
    eventId: string;
    autosave?: ContentEditorAutosaveState;
    preview?: ContentEditorPreview;
    actionsUnavailableReason?: string;
  } = { eventId: 'evt_demo_001' },
): ContentEditorFixtureAdapter {
  const channel = contentChannelFromRoute(kind);
  const fixture = createContentEditorFixture({
    channel,
    eventId: options.eventId,
    autosave: options.autosave,
  });

  return {
    ...fixture,
    preview: options.preview ?? fixture.preview,
    channelLabel: fixtureChannelLabel(channel),
    routeTitle: titleForKind(kind),
    routeDescription: descriptionForKind(kind),
    actionsUnavailableReason:
      options.actionsUnavailableReason ??
      'Fixture editor: publish and test-send connect when channel adapters land.',
  };
}

function titleForKind(kind: ContentEditorRouteKind): string {
  switch (kind) {
    case 'event-page':
      return 'Event page editor';
    case 'email':
      return 'Email template editor';
    case 'sms':
      return 'SMS template editor';
  }
}

function descriptionForKind(kind: ContentEditorRouteKind): string {
  switch (kind) {
    case 'event-page':
      return 'Build the hosted event page shell with canvas, inserts, preview, and blockers.';
    case 'email':
      return 'Author email templates with React Email export and Tixkit publish blockers.';
    case 'sms':
      return 'Author SMS templates with segment accounting, opt-out checks, and preview guardrails.';
  }
}
