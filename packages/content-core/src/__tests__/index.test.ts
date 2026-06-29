import { describe, it, expect } from 'vitest';
import {
  RENDER_CONTRACTS,
  SUPPORTED_CONTENT_CHANNELS,
  CONTENT_SCHEMA_VERSION,
  validateContentVersion,
  transitionDocumentStatus,
  ContentError,
  ChannelAdapterRegistry,
  createDefaultChannelRegistry,
  variableDefinitionsForChannel,
  fixtureEmailDocument,
  fixtureEventPageDocument,
  fixtureSmsDocument,
} from '../index.js';

describe('render contracts', () => {
  it('defines a contract per channel with correct escape/output modes', () => {
    expect(RENDER_CONTRACTS.email.escape).toBe('html');
    expect(RENDER_CONTRACTS.sms.escape).toBe('plain');
    expect(RENDER_CONTRACTS.sms.supportsOptOut).toBe(true);
    expect(RENDER_CONTRACTS.sms.supportsSegmentAccounting).toBe(true);
    expect(RENDER_CONTRACTS.event_page.output).toBe('html');
  });

  it('every supported channel has a contract', () => {
    for (const channel of SUPPORTED_CONTENT_CHANNELS) {
      expect(RENDER_CONTRACTS[channel]).toBeTruthy();
    }
  });
});

describe('validateContentVersion - email', () => {
  it('passes for a valid email with subject and known variables', () => {
    const result = validateContentVersion(
      {
        subject: 'Hi {{recipient.name}}',
        renderedHtml: '<p>Welcome {{recipient.name}}</p>',
        contentJson: {},
      },
      'email',
    );
    expect(result.valid).toBe(true);
  });

  it('blocks publish when the subject is missing', () => {
    const result = validateContentVersion(
      { subject: '', renderedHtml: '<p>Hi</p>', contentJson: {} },
      'email',
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'missing_subject')).toBe(true);
  });

  it('blocks publish for unknown merge tags', () => {
    const result = validateContentVersion(
      { subject: 'Hi {{bogus.tag}}', renderedHtml: '', contentJson: {} },
      'email',
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'unknown_variable')).toBe(true);
  });
});

describe('validateContentVersion - sms', () => {
  it('passes for a valid sms body', () => {
    const result = validateContentVersion(
      { renderedText: 'Your ticket {{ticket.code}} is ready', contentJson: {} },
      'sms',
    );
    expect(result.valid).toBe(true);
  });

  it('blocks publish when the body is missing', () => {
    const result = validateContentVersion({ renderedText: '', contentJson: {} }, 'sms');
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'missing_body')).toBe(true);
  });

  it('blocks publish when the segment count exceeds the limit', () => {
    const result = validateContentVersion(
      { renderedText: 'a'.repeat(200), contentJson: {} },
      'sms',
      { smsSegmentLimit: 2, smsSegmentCount: 3 },
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'segment_limit_exceeded')).toBe(true);
  });
});

describe('validateContentVersion - stubbed channels fail closed', () => {
  it('imessage is unavailable', () => {
    const result = validateContentVersion({ contentJson: {} }, 'imessage');
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'channel_unavailable')).toBe(true);
  });

  it('social_invite is unavailable', () => {
    expect(validateContentVersion({ contentJson: {} }, 'social_invite').valid).toBe(false);
  });
});

describe('document status state machine', () => {
  it('allows draft -> published', () => {
    expect(transitionDocumentStatus('draft', 'published')).toBe('published');
  });

  it('allows published -> archived', () => {
    expect(transitionDocumentStatus('published', 'archived')).toBe('archived');
  });

  it('rejects invalid transitions', () => {
    expect(() => transitionDocumentStatus('archived', 'published')).toThrow(ContentError);
  });
});

describe('channel adapter registry', () => {
  it('default registry marks supported channels available and stubbed channels unavailable', () => {
    const registry = createDefaultChannelRegistry();
    expect(registry.isAvailable('email')).toBe(true);
    expect(registry.isAvailable('sms')).toBe(true);
    expect(registry.isAvailable('imessage')).toBe(false);
  });

  it('assertAvailable throws for unavailable channels', () => {
    const registry = createDefaultChannelRegistry();
    expect(() => registry.assertAvailable('imessage')).toThrow(ContentError);
    expect(() => registry.assertAvailable('email')).not.toThrow();
  });

  it('can register a custom adapter', () => {
    const registry = new ChannelAdapterRegistry();
    registry.register({ channel: 'email', available: true, renderContract: RENDER_CONTRACTS.email });
    expect(registry.get('email')?.available).toBe(true);
  });
});

describe('variable metadata', () => {
  it('returns definitions from the shared merge-tag registry with required flags', () => {
    const defs = variableDefinitionsForChannel('email');
    expect(defs.length).toBeGreaterThan(5);
    expect(defs.find((d) => d.key === 'recipient.name')?.required).toBe(true);
  });
});

describe('fixtures', () => {
  it('email fixture defaults to the email channel', () => {
    expect(fixtureEmailDocument().channel).toBe('email');
  });
  it('sms fixture defaults to the sms channel', () => {
    expect(fixtureSmsDocument().channel).toBe('sms');
  });

  it('event page fixture defaults to the event_page channel', () => {
    expect(fixtureEventPageDocument().channel).toBe('event_page');
  });
});

describe('schema version', () => {
  it('exposes a content schema version', () => {
    expect(CONTENT_SCHEMA_VERSION).toBeGreaterThan(0);
  });
});
