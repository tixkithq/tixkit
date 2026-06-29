import {
  CONTENT_SCHEMA_VERSION,
  RENDER_CONTRACTS,
  createDefaultChannelRegistry,
  fixtureEmailDocument,
  fixtureEventPageDocument,
  fixtureSmsDocument,
  validateContentVersion,
  variableDefinitionsForChannel,
  type ContentChannel,
  type ContentDocument,
  type ContentDocumentVersion,
} from '@tixkit/content-core';
import type {
  ContentEditorAutosaveState,
  ContentEditorCanvasBlock,
  ContentEditorInsertAction,
  ContentEditorPreview,
  ContentEditorVersionSummary,
} from './shell.js';

export type ContentEditorFixtureOptions = {
  channel: ContentChannel;
  eventId?: string;
  autosave?: ContentEditorAutosaveState;
  includeBlockers?: boolean;
};

export function fixtureChannelLabel(channel: ContentChannel): string {
  switch (channel) {
    case 'event_page':
      return 'Event page';
    case 'email':
      return 'Email template';
    case 'sms':
      return 'SMS template';
    case 'imessage':
      return 'iMessage template';
    case 'social_invite':
      return 'Social invite';
  }
}

export function createContentEditorFixture(options: ContentEditorFixtureOptions): {
  document: ContentDocument;
  draft: ContentDocumentVersion;
  versions: ContentEditorVersionSummary[];
  insertActions: ContentEditorInsertAction[];
  canvasBlocks: ContentEditorCanvasBlock[];
  preview: ContentEditorPreview;
  autosave: ContentEditorAutosaveState;
  unavailableReason?: string;
} {
  const registry = createDefaultChannelRegistry();
  const unavailableReason = registry.isAvailable(options.channel)
    ? undefined
    : `${fixtureChannelLabel(options.channel)} is not enabled for this workspace.`;
  const document = documentForChannel(options.channel, options.eventId);
  const draft = draftForChannel(document, options.includeBlockers ?? false);

  return {
    document,
    draft,
    versions: [
      {
        id: draft.id,
        label: 'Draft v3',
        status: 'draft',
        timestamp: draft.createdAt,
        author: 'Local Organizer',
      },
      {
        id: `${draft.documentId}_published_v2`,
        label: 'Published v2',
        status: 'published',
        timestamp: '2026-06-12T18:15:00Z',
        author: 'Operations',
      },
    ],
    insertActions: insertActionsForChannel(options.channel),
    canvasBlocks: blocksForChannel(options.channel),
    preview: previewForChannel(options.channel),
    autosave: options.autosave ?? 'saved',
    unavailableReason,
  };
}

function documentForChannel(channel: ContentChannel, eventId?: string): ContentDocument {
  if (channel === 'event_page') {
    return fixtureEventPageDocument({ eventId: eventId ?? 'evt_demo_001' });
  }
  if (channel === 'sms') {
    return fixtureSmsDocument();
  }
  if (channel === 'email') {
    return fixtureEmailDocument();
  }
  return fixtureEmailDocument({
    id: `cdoc_${channel}_1`,
    channel,
    key: channel,
    name: fixtureChannelLabel(channel),
  });
}

function draftForChannel(
  document: ContentDocument,
  includeBlockers: boolean,
): ContentDocumentVersion {
  const renderedHtml = document.channel === 'sms'
    ? undefined
    : '<main><h1>{{event.title}}</h1><p>{{event.startsAt}}</p></main>';
  const renderedText = document.channel === 'sms'
    ? 'Hi {{recipient.name}}, your ticket for {{event.title}} is ready. Reply STOP to opt out.'
    : 'Your ticket for {{event.title}} is ready.';
  const subject = document.channel === 'email' && !includeBlockers
    ? 'Your {{event.title}} tickets are ready'
    : document.channel === 'email'
      ? ''
      : undefined;
  const validation = validateContentVersion(
    {
      subject,
      renderedHtml,
      renderedText,
      contentJson: { fixture: true, channel: document.channel },
    },
    document.channel,
    { smsSegmentCount: 1 },
  );

  return {
    id: `${document.id}_draft_v3`,
    documentId: document.id,
    versionNumber: 3,
    status: 'draft',
    schemaVersion: CONTENT_SCHEMA_VERSION,
    subject,
    previewText: document.channel === 'email' ? 'Everything attendees need before arrival.' : undefined,
    contentJson: { fixture: true, channel: document.channel },
    renderedHtml,
    renderedText,
    variables: variableDefinitionsForChannel(document.channel).slice(0, 6),
    validation,
    createdBy: 'usr_local',
    createdAt: '2026-06-28T15:45:00Z',
  };
}

function insertActionsForChannel(channel: ContentChannel): ContentEditorInsertAction[] {
  if (channel === 'event_page') {
    return [
      { id: 'text', label: 'Text', icon: 'text' },
      { id: 'image', label: 'Image', icon: 'image' },
      { id: 'gallery', label: 'Gallery', icon: 'image' },
      { id: 'details', label: 'Details', icon: 'calendar' },
      { id: 'tickets', label: 'Tickets', icon: 'ticket' },
      { id: 'products', label: 'Add-ons', icon: 'ticket' },
      { id: 'schedule', label: 'Schedule', icon: 'calendar' },
      { id: 'venue', label: 'Venue', icon: 'map' },
      { id: 'faq', label: 'FAQ', icon: 'shield' },
      { id: 'sponsors', label: 'Sponsors', icon: 'image' },
      { id: 'hosts', label: 'Hosts', icon: 'variable' },
      { id: 'button', label: 'Button', icon: 'link' },
      { id: 'divider', label: 'Divider', icon: 'code' },
      { id: 'social', label: 'Social', icon: 'link' },
      { id: 'embed', label: 'Embed', icon: 'code' },
    ];
  }
  if (channel === 'sms') {
    return [
      { id: 'variable', label: 'Variable', icon: 'variable' },
      { id: 'link', label: 'Link', icon: 'link' },
      { id: 'opt-out', label: 'Opt-out', icon: 'shield' },
    ];
  }
  return [
    { id: 'hero', label: 'Hero', icon: 'image' },
    { id: 'ticket-summary', label: 'Ticket summary', icon: 'ticket' },
    { id: 'calendar', label: 'Calendar', icon: 'calendar' },
    { id: 'footer', label: 'Footer', icon: 'shield' },
  ];
}

function blocksForChannel(channel: ContentChannel): ContentEditorCanvasBlock[] {
  if (channel === 'sms') {
    return [
      {
        id: 'sms-body',
        label: 'Message body',
        summary: 'Personalized reminder with opt-out token and segment accounting.',
      },
    ];
  }
  if (channel === 'event_page') {
    return [
      {
        id: 'event-hero',
        label: 'Hero',
        summary: 'Event name, date, and primary call to action.',
      },
      {
        id: 'ticket-grid',
        label: 'Tickets',
        summary: 'Available ticket types and purchase entry point.',
      },
      {
        id: 'venue',
        label: 'Venue',
        summary: 'Location, map, and arrival notes.',
      },
    ];
  }
  return [
    {
      id: 'email-hero',
      label: 'Hero',
      summary: 'Event branding, headline, and preview-safe image slot.',
    },
    {
      id: 'order-summary',
      label: 'Order summary',
      summary: 'Ticket counts, order total, and QR-code delivery note.',
    },
    {
      id: 'footer',
      label: 'Footer',
      summary: 'Organizer contact and unsubscribe language.',
    },
  ];
}

function previewForChannel(channel: ContentChannel): ContentEditorPreview {
  const contract = RENDER_CONTRACTS[channel];
  if (channel === 'sms') {
    return {
      label: 'Sample SMS',
      output: 'Hi Ada, your ticket for All Access Chicago is ready. Reply STOP to opt out.',
      format: contract.output,
    };
  }
  if (channel === 'event_page') {
    return {
      label: 'Hosted page',
      output: 'All Access Chicago · Friday, July 17 · General admission from $35',
      format: contract.output,
    };
  }
  return {
    label: 'Inbox preview',
    output: 'Your All Access Chicago tickets are ready · Everything attendees need before arrival.',
    format: contract.output,
  };
}
