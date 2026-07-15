import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { agentSha256, installAgentProtocolSchemaKeywords } from '@tixkit/agent-protocol';
import { createDefaultEventPageDocument } from '@tixkit/content-event-page';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { prepareAgentEventPageContent } from '../services/agent-content-prepare.js';

const event = {
  id: 'evt_1',
  slug: 'summer-night',
  title: 'Summer Night',
  description: 'Doors at seven.',
  startsAt: '2026-08-20T00:00:00.000Z',
  endsAt: '2026-08-20T03:00:00.000Z',
  timezone: 'America/Chicago',
  coverImageUrl: '/v1/public/event-media/media_1/original',
};

const actionContracts = JSON.parse(
  readFileSync(
    new URL(
      '../../../agent-protocol/schemas/agent-action-contracts-2026-08-02.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const retainedActionContracts = JSON.parse(
  readFileSync(
    new URL(
      '../../../agent-protocol/schemas/agent-action-contracts-2026-07-27.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
const addFormats = createRequire(import.meta.url)('ajv-formats') as FormatsPlugin;
addFormats(ajv);
installAgentProtocolSchemaKeywords(ajv as never);
ajv.addSchema(retainedActionContracts);
ajv.addSchema(actionContracts);
const validatePreparedResult = ajv.getSchema(`${actionContracts.$id}#/$defs/contentPrepareResult`)!;

function content() {
  return createDefaultEventPageDocument({
    eventId: event.id,
    eventTitle: event.title,
    eventDescription: event.description,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timezone: event.timezone,
    coverImageUrl: event.coverImageUrl,
    publicUrl: `/e/${event.slug}`,
  });
}

describe('agent event-page content preparation', () => {
  it('canonicalizes and binds a safe mutation-free preview to the locked event snapshot', () => {
    const submitted = content() as unknown as Record<string, unknown>;
    submitted.ignoredSecret = 'must-not-survive';
    const prepared = prepareAgentEventPageContent({
      event,
      content: submitted,
    });

    expect(prepared.channel).toBe('event_page');
    expect(prepared.content).not.toHaveProperty('ignoredSecret');
    expect(prepared.preview.provider).toBe('@puckeditor/core');
    expect(prepared.preview.discovery).toMatchObject({
      title: event.title,
      startsAt: event.startsAt,
      publicPath: `/e/${event.slug}`,
    });
    expect(prepared.contentPreviewSha256).toBe(
      agentSha256({
        channel: prepared.channel,
        content: prepared.content,
        preview: prepared.preview,
        validation: prepared.validation,
      }),
    );
    const result = {
      resourceId: event.id,
      resourceVersion: 7,
      ...prepared,
      observedAt: '2026-08-02T12:00:00.000Z',
      untrustedContentPaths: ['content', 'preview.discovery'],
    };
    expect(validatePreparedResult(result), ajv.errorsText(validatePreparedResult.errors)).toBe(
      true,
    );
  });

  it('rejects unsupported blocks and unsafe embeds, including nested zones', () => {
    const unsupported = content();
    unsupported.editor.data.content.push({
      type: 'RichText',
      props: { id: 'rich_1', body: 'hello' },
    });
    expect(() => prepareAgentEventPageContent({ event, content: unsupported })).toThrow(
      'AGENT_ACTION_CONTENT_UNSUPPORTED',
    );

    const embedded = content();
    embedded.editor.data.content.push({
      type: 'CustomEmbed',
      props: {
        id: 'embed_1',
        html: '<iframe src="https://example.com"></iframe>',
        allowUnsafeEmbed: true,
      },
    });
    expect(() => prepareAgentEventPageContent({ event, content: embedded })).toThrow(
      'AGENT_ACTION_CONTENT_UNSAFE',
    );

    const zoned = content() as unknown as {
      editor: { data: { zones: Record<string, unknown[]> } };
    };
    zoned.editor.data.zones = {
      hidden: [
        {
          type: 'CustomEmbed',
          props: { id: 'embed_2', html: '<script>x</script>' },
        },
      ],
    };
    expect(() => prepareAgentEventPageContent({ event, content: zoned })).toThrow(
      'AGENT_ACTION_CONTENT_UNSAFE',
    );
  });

  it('fails closed for malformed zones, cycles, bigint, depth and size abuse', () => {
    const malformed = content() as unknown as {
      editor: { data: { zones: unknown } };
    };
    malformed.editor.data.zones = { bad: [null] };
    expect(() => prepareAgentEventPageContent({ event, content: malformed })).toThrow(
      'AGENT_ACTION_CONTENT_INVALID',
    );

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => prepareAgentEventPageContent({ event, content: cyclic })).toThrow(
      'AGENT_ACTION_CONTENT_INVALID',
    );
    expect(() => prepareAgentEventPageContent({ event, content: { value: 1n } })).toThrow(
      'AGENT_ACTION_CONTENT_INVALID',
    );

    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let index = 0; index < 30; index += 1) {
      deep.next = {};
      deep = deep.next as Record<string, unknown>;
    }
    expect(() => prepareAgentEventPageContent({ event, content: root })).toThrow(
      'AGENT_ACTION_CONTENT_INVALID',
    );
    expect(() =>
      prepareAgentEventPageContent({
        event,
        content: { value: 'x'.repeat(100_001) },
      }),
    ).toThrow('AGENT_ACTION_CONTENT_TOO_LARGE');
  });

  it('rejects primitive type confusion and unsupported non-empty component arrays', () => {
    const confused = content();
    const header = confused.editor.data.content.find((block) => block.type === 'EventHeader');
    expect(header).toBeDefined();
    (header!.props as Record<string, unknown>).showDate = 'false';
    expect(() => prepareAgentEventPageContent({ event, content: confused })).toThrow(
      'AGENT_ACTION_CONTENT_INVALID',
    );

    const logos = content();
    const logoHeader = logos.editor.data.content.find((block) => block.type === 'EventHeader');
    (logoHeader!.props as Record<string, unknown>).logos = [
      { name: 'Unsafe external logo', imageUrl: 'https://example.test/logo.svg' },
    ];
    expect(() => prepareAgentEventPageContent({ event, content: logos })).toThrow(
      'AGENT_ACTION_CONTENT_UNSUPPORTED',
    );

    const overlays = content();
    const description = overlays.editor.data.content.find(
      (block) => block.type === 'EventDescription',
    );
    (description!.props as Record<string, unknown>).imageOverlay = [{ html: '<script>x</script>' }];
    expect(() => prepareAgentEventPageContent({ event, content: overlays })).toThrow(
      'AGENT_ACTION_CONTENT_UNSUPPORTED',
    );
  });

  it('enforces the 100-block contract after migration inserts required chrome', () => {
    const maximum = content();
    while (maximum.editor.data.content.length < 100) {
      maximum.editor.data.content.push({
        type: 'Divider',
        props: { id: `divider-${maximum.editor.data.content.length}`, spacing: 'normal' },
      });
    }
    expect(prepareAgentEventPageContent({ event, content: maximum }).content).toMatchObject({
      schemaVersion: 2,
    });

    maximum.editor.data.content.push({
      type: 'Divider',
      props: { id: 'divider-over-limit', spacing: 'normal' },
    });
    expect(() => prepareAgentEventPageContent({ event, content: maximum })).toThrow(
      'AGENT_ACTION_CONTENT_TOO_LARGE',
    );
  });
});
