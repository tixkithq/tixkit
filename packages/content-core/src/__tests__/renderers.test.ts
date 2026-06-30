import { describe, it, expect } from 'vitest';
import {
  renderContent,
  renderPreview,
  withinSmsSegmentBudget,
  RENDER_CONTRACTS,
} from '../index.js';
import type { MergeTagContext } from '@tixkit/domain';

const sampleContext: MergeTagContext = {
  recipient: { name: 'Jordan Lee' },
  event: { title: 'Summer Showcase', venueCity: 'Brooklyn' },
  ticket: { type: 'GA', code: 'TKT-ABC123' },
  brand: { name: 'Acme Events' },
};

describe('renderContent - email', () => {
  it('renders subject as plain and html as HTML-escaped', () => {
    const out = renderContent({
      channel: 'email',
      contract: RENDER_CONTRACTS.email,
      subject: 'Hi {{recipient.name}}',
      html: '<p>Welcome {{recipient.name}} to {{event.title}}</p>',
      context: { ...sampleContext, recipient: { name: '<script>' } },
    });
    expect(out.subject).toBe('Hi <script>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).toContain('Summer Showcase');
  });

  it('preview equals send for the same content + context', () => {
    const content = { subject: 'Hi {{recipient.name}}', html: '<p>{{event.title}}</p>' };
    const send = renderContent({
      channel: 'email',
      contract: RENDER_CONTRACTS.email,
      context: sampleContext,
      ...content,
    });
    const preview = renderPreview('email', RENDER_CONTRACTS.email, content, sampleContext);
    expect(preview).toEqual(send);
  });
});

describe('renderContent - sms', () => {
  it('renders plain text, injects opt-out, and counts segments', () => {
    const out = renderContent({
      channel: 'sms',
      contract: RENDER_CONTRACTS.sms,
      text: 'Hi {{recipient.name}}, ticket {{ticket.code}} ready',
      context: sampleContext,
      optOutToken: 'Reply STOP to opt out',
    });
    expect(out.text).toBe('Hi Jordan Lee, ticket TKT-ABC123 ready. Reply STOP to opt out');
    expect(out.segments).toBeGreaterThanOrEqual(1);
  });

  it('omits opt-out when no token is provided', () => {
    const out = renderContent({
      channel: 'sms',
      contract: RENDER_CONTRACTS.sms,
      text: 'Hi {{recipient.name}}',
      context: sampleContext,
    });
    expect(out.text).toBe('Hi Jordan Lee');
    expect(out.text).not.toContain('STOP');
  });

  it('uses fallback for missing variables', () => {
    const out = renderContent({
      channel: 'sms',
      contract: RENDER_CONTRACTS.sms,
      text: 'Hi {{attendee.name}}',
      context: { recipient: { name: 'Jordan' } },
    });
    expect(out.text).toBe('Hi ');
  });
});

describe('renderContent - event page', () => {
  it('renders HTML with HTML escaping', () => {
    const out = renderContent({
      channel: 'event_page',
      contract: RENDER_CONTRACTS.event_page,
      html: '<h1>{{event.title}}</h1>',
      context: { event: { title: '<b>Show</b>' } },
    });
    expect(out.html).toBe('<h1>&lt;b&gt;Show&lt;/b&gt;</h1>');
  });
});

describe('renderContent - stubbed channels fail closed', () => {
  it('imessage rendering throws', () => {
    expect(() =>
      renderContent({ channel: 'imessage', contract: RENDER_CONTRACTS.imessage, context: {} }),
    ).toThrow(/not implemented/);
  });
});

describe('withinSmsSegmentBudget', () => {
  it('returns true within the budget and false over it', () => {
    expect(withinSmsSegmentBudget('hello', 1)).toBe(true);
    expect(withinSmsSegmentBudget('a'.repeat(200), 1)).toBe(false);
  });
});

describe('render determinism (parity)', () => {
  it('repeated rendering with the same inputs is identical', () => {
    const content = { subject: 'Hi {{recipient.name}}', html: '<p>{{event.title}}</p>' };
    const a = renderContent({
      channel: 'email',
      contract: RENDER_CONTRACTS.email,
      context: sampleContext,
      ...content,
    });
    const b = renderContent({
      channel: 'email',
      contract: RENDER_CONTRACTS.email,
      context: sampleContext,
      ...content,
    });
    expect(a).toEqual(b);
  });
});
