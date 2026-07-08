import { describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import {
  createDefaultEventPageDocument,
  type EventPagePuckData,
} from '@tixkit/content-event-page';
import {
  EVENT_PAGE_PUCK_STYLES_CLASS,
  EventPageRender,
  createEventPageRenderStyle,
  eventPagePuckConfig,
  eventPagePuckIframeConfig,
  isEventPagePuckComponentType,
  resolveRenderData,
} from '../index.js';

const document = createDefaultEventPageDocument({
  eventId: 'evt_demo_001',
  eventTitle: 'All Access Chicago',
  eventDescription: 'A full night of music and access.',
  startsAt: '2026-07-17T19:00:00.000Z',
  timezone: 'America/Chicago',
  venue: { name: 'The Salt Shed', city: 'Chicago' },
  brandName: 'Tixkit',
  coverImageUrl: 'https://cdn.example.test/cover.jpg',
  coverImageAlt: 'Crowd at All Access Chicago',
});

describe('eventPagePuckConfig', () => {
  it('registers content-only Puck components and excludes commerce chrome', () => {
    expect(Object.keys(eventPagePuckConfig.components)).toEqual([
      'Hero',
      'RichText',
      'Media',
      'EventDetails',
      'Schedule',
      'Venue',
      'FAQ',
      'Sponsors',
      'Speakers',
      'Button',
      'Divider',
      'SocialLinks',
      'CustomEmbed',
    ]);
    expect(eventPagePuckConfig.components).not.toHaveProperty('Tickets');
    expect(eventPagePuckConfig.components).not.toHaveProperty('ResaleTickets');
    expect(eventPagePuckConfig.components).not.toHaveProperty('Footer');
  });

  it('configures rich text, root fields, and iframe isolation defaults', () => {
    expect(eventPagePuckConfig.root?.fields).toEqual(
      expect.objectContaining({
        title: expect.objectContaining({ type: 'text' }),
        backgroundColor: expect.objectContaining({ type: 'text' }),
        accentColor: expect.objectContaining({ type: 'text' }),
      }),
    );
    expect(eventPagePuckConfig.components.RichText.fields?.body).toEqual(
      expect.objectContaining({
        type: 'richtext',
        contentEditable: true,
      }),
    );
    expect(eventPagePuckIframeConfig).toEqual({
      enabled: true,
      waitForStyles: true,
      syncHostStyles: false,
    });
  });

  it('exposes a component type guard', () => {
    expect(isEventPagePuckComponentType('Hero')).toBe(true);
    expect(isEventPagePuckComponentType('tickets')).toBe(false);
  });
});

describe('EventPageRender', () => {
  it('renders Puck data with the isolated style scope and brand variables', () => {
    const { container } = render(
      <EventPageRender
        document={document}
        brandVariables={{ background: '#101010', foreground: '#ffffff', accent: '#ffcc00' }}
      />,
    );

    const scope = container.querySelector(`.${EVENT_PAGE_PUCK_STYLES_CLASS}`) as HTMLElement | null;
    expect(scope).not.toBeNull();
    expect(scope?.dataset.provider).toBe('@puckeditor/core');
    expect(scope?.style.getPropertyValue('--tk-brand-bg')).toBe('#101010');
    expect(scope?.style.getPropertyValue('--tk-brand-fg')).toBe('#ffffff');
    expect(scope?.style.getPropertyValue('--tk-brand-accent')).toBe('#ffcc00');
    expect(screen.getByRole('heading', { level: 1, name: 'All Access Chicago' })).toBeInTheDocument();
    expect(screen.getAllByText('The Salt Shed').length).toBeGreaterThan(0);
  });

  it('renders fallback for invalid documents when validation is enabled', () => {
    const invalid: EventPagePuckData = {
      root: { props: {} },
      content: [{ type: 'tickets' as never, props: { id: 'legacy-ticket' } }],
    };

    render(<EventPageRender data={invalid} fallback={<p>Invalid page</p>} />);
    expect(screen.getByText('Invalid page')).toBeInTheDocument();
    expect(screen.queryByText('legacy-ticket')).toBeNull();
  });

  it('can resolve data from either a full document or direct data', () => {
    expect(resolveRenderData(document, undefined)).toBe(document.editor.data);
    expect(resolveRenderData(undefined, document.editor.data)).toBe(document.editor.data);
    expect(resolveRenderData({ schemaVersion: 1 }, undefined)).toBeUndefined();
  });

  it('maps brand variables for host style application', () => {
    expect(createEventPageRenderStyle({ accentForeground: '#000000', radius: '6px' })).toEqual({
      '--tk-brand-accent-fg': '#000000',
      '--tk-brand-radius': '6px',
    });
  });
});
