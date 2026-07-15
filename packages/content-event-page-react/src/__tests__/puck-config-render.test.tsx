import { describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import {
  createDefaultEventPageDocument,
  eventPageMediaReference,
  type EventPagePuckData,
} from '@tixkit/content-event-page';
import {
  EVENT_PAGE_PUCK_STYLES_CLASS,
  ButtonBlock,
  EventDetailsBlock,
  EventDescriptionBlock,
  MediaBlock,
  EventPageRuntimeProvider,
  EventPageRender,
  ProductAddOnsBlock,
  ResaleTicketsBlock,
  TicketsBlock,
  createEventPagePuckConfig,
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
  it('registers full-page Puck components including editable chrome', () => {
    expect(Object.keys(eventPagePuckConfig.components)).toEqual([
      'EventDescription',
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
      'EventHeader',
      'Tickets',
      'ProductAddOns',
      'ResaleTickets',
      'CheckoutCta',
      'BrandFooter',
    ]);
    expect(eventPagePuckConfig.components).toHaveProperty('EventHeader');
    expect(eventPagePuckConfig.components).toHaveProperty('EventDescription');
    expect(eventPagePuckConfig.components).toHaveProperty('Tickets');
    expect(eventPagePuckConfig.components).toHaveProperty('ResaleTickets');
    expect(eventPagePuckConfig.components).toHaveProperty('BrandFooter');
    expect(eventPagePuckConfig.components).not.toHaveProperty('Footer');
  });

  it('configures rich text, root fields, and iframe isolation defaults', () => {
    expect(eventPagePuckConfig.root?.fields).toEqual(
      expect.objectContaining({
        title: expect.objectContaining({ type: 'text' }),
        backgroundColor: expect.objectContaining({ type: 'custom' }),
        accentColor: expect.objectContaining({ type: 'custom' }),
        fontFamily: expect.objectContaining({ type: 'custom' }),
        radius: expect.objectContaining({ type: 'custom' }),
      }),
    );
    expect(eventPagePuckConfig.components.EventHeader.fields?.imageUrl).toEqual(
      expect.objectContaining({ type: 'custom' }),
    );
    expect(eventPagePuckConfig.components.EventHeader.fields?.logos).toEqual(
      expect.objectContaining({ type: 'custom' }),
    );
    expect(eventPagePuckConfig.components.EventDescription.fields?.imageUrl).toEqual(
      expect.objectContaining({ type: 'custom' }),
    );
    expect(eventPagePuckConfig.components.EventDescription.fields?.logos).toEqual(
      expect.objectContaining({ type: 'custom' }),
    );
    expect(eventPagePuckConfig.components.EventDescription.fields?.imageOverlay).toEqual(
      expect.objectContaining({ type: 'slot' }),
    );
    expect(eventPagePuckConfig.components.EventHeader.fields).not.toHaveProperty('startsAtLabel');
    expect(eventPagePuckConfig.components.EventHeader.fields).not.toHaveProperty('timezone');
    expect(eventPagePuckConfig.components.EventHeader.fields).not.toHaveProperty('venueName');
    expect(eventPagePuckConfig.components.RichText.fields?.body).toEqual(
      expect.objectContaining({
        type: 'richtext',
        contentEditable: true,
      }),
    );
    for (const [component, field] of [
      ['EventHeader', 'brandLabel'],
      ['Tickets', 'emptyTitle'],
      ['Tickets', 'emptyDescription'],
      ['ResaleTickets', 'badgeLabel'],
      ['CheckoutCta', 'supportingText'],
      ['BrandFooter', 'label'],
    ] as const) {
      const fields = eventPagePuckConfig.components[component].fields as unknown as Record<
        string,
        unknown
      >;
      expect(fields[field]).toEqual(
        expect.objectContaining({ contentEditable: true, visible: false }),
      );
    }
    expect(eventPagePuckIframeConfig).toEqual({
      enabled: true,
      waitForStyles: true,
      syncHostStyles: true,
    });
  });

  it('renders richer Puck controls for page styling fields', () => {
    const field = eventPagePuckConfig.root?.fields?.backgroundColor as unknown as {
      label?: string;
      render: (props: {
        field: { label?: string };
        id: string;
        name: string;
        value: string;
        onChange: (value: string) => void;
      }) => ReactElement;
    };
    const changes: string[] = [];

    render(
      field.render({
        field,
        id: 'background-color',
        name: 'backgroundColor',
        value: '#ffffff',
        onChange: (value) => changes.push(value),
      }),
    );

    expect(screen.getByText('Canvas color behind all sections.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use #0f172a' }));

    expect(changes).toContain('#0f172a');
  });

  it('offers owned event media choices and stores only the portable role reference', () => {
    const changes: string[] = [];
    const config = createEventPagePuckConfig({
      eventMediaChoices: [
        {
          role: 'poster',
          label: 'Event poster',
          value: eventPageMediaReference('poster'),
          previewUrl: 'blob:poster-preview',
          altText: 'Poster alternative',
        },
      ],
    });
    const field = config.components.Media.fields?.imageUrl as unknown as {
      label?: string;
      render: (props: {
        field: { label?: string };
        id: string;
        name: string;
        value: string;
        onChange: (value: string) => void;
      }) => ReactElement;
    };

    const { container } = render(
      field.render({
        field,
        id: 'media-image',
        name: 'imageUrl',
        value: '',
        onChange: (value) => changes.push(value),
      }),
    );

    const choice = screen.getByRole('button', { name: 'Event poster' });
    expect(choice).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(choice);
    expect(changes).toEqual(['tixkit:event-media:poster']);
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:poster-preview');
  });

  it('resolves role references from runtime media and fails closed when the role is unavailable', () => {
    const posterReference = eventPageMediaReference('poster');
    const runtime = {
      brandName: 'Tixkit',
      brandFooterLabel: 'Powered by Tixkit',
      tickets: [],
      eventMedia: {
        poster: {
          url: 'blob:poster-preview',
          altText: 'Accessible event poster',
        },
      },
      interactive: false,
    };
    const { rerender } = render(
      <EventPageRuntimeProvider value={runtime}>
        <MediaBlock id="owned-poster" imageUrl={posterReference} imageAlt="" />
      </EventPageRuntimeProvider>,
    );

    expect(screen.getByRole('img', { name: 'Accessible event poster' })).toHaveAttribute(
      'src',
      'blob:poster-preview',
    );

    rerender(
      <EventPageRuntimeProvider value={{ ...runtime, eventMedia: {} }}>
        <MediaBlock id="owned-poster" imageUrl={posterReference} imageAlt="" />
      </EventPageRuntimeProvider>,
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it.each([
    '/v1/events/evt_private/media/renditions/emr_private',
    '/v1/upload-artifacts/upl_private',
    'https://user:secret@cdn.example.test/hero.jpg',
    'https://cdn.example.test/hero.jpg?token=private',
  ])('does not render an unsafe stored image source: %s', (unsafeImageUrl) => {
    const runtime = {
      brandName: 'Tixkit',
      brandFooterLabel: 'Powered by Tixkit',
      tickets: [],
      interactive: true,
    };
    const { container } = render(
      <EventPageRuntimeProvider value={runtime}>
        <EventDescriptionBlock
          id="unsafe-description"
          title="Description remains visible"
          body="No private image should render."
          imageUrl={unsafeImageUrl}
          imageAlt="Private description image"
        />
        <MediaBlock id="unsafe-media" imageUrl={unsafeImageUrl} imageAlt="Private media image" />
      </EventPageRuntimeProvider>,
    );

    expect(screen.getByText('Description remains visible')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(unsafeImageUrl);
  });

  it('does not render an unsafe URL supplied for a logical media role on a public page', () => {
    const unsafeImageUrl = '/v1/events/evt_private/media/renditions/emr_private';
    const { container } = render(
      <EventPageRuntimeProvider
        value={{
          brandName: 'Tixkit',
          brandFooterLabel: 'Powered by Tixkit',
          tickets: [],
          eventMedia: {
            poster: { url: unsafeImageUrl, altText: 'Private poster' },
          },
          interactive: true,
        }}
      >
        <MediaBlock
          id="unsafe-owned-poster"
          imageUrl={eventPageMediaReference('poster')}
          imageAlt=""
        />
      </EventPageRuntimeProvider>,
    );

    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(unsafeImageUrl);
  });

  it('exposes complete discovery settings and editable collection content', () => {
    expect(eventPagePuckConfig.root?.fields).toEqual(
      expect.objectContaining({
        marketingSummary: expect.objectContaining({ type: 'textarea' }),
        category: expect.objectContaining({ type: 'text' }),
        tags: expect.objectContaining({ type: 'text' }),
        coverImageUrl: expect.objectContaining({ type: 'custom' }),
        socialImageUrl: expect.objectContaining({ type: 'custom' }),
      }),
    );

    for (const component of ['EventDetails', 'Schedule', 'FAQ', 'Sponsors', 'Speakers'] as const) {
      const items = eventPagePuckConfig.components[component].fields?.items as unknown as {
        visible?: boolean;
        arrayFields?: Record<string, { visible?: boolean }>;
      };
      expect(items.visible).not.toBe(false);
      expect(Object.values(items.arrayFields ?? {}).some((field) => field.visible !== false)).toBe(
        true,
      );
    }
    const links = eventPagePuckConfig.components.SocialLinks.fields?.links as unknown as {
      visible?: boolean;
      arrayFields?: Record<string, { visible?: boolean }>;
    };
    expect(links.visible).not.toBe(false);
    expect(links.arrayFields?.label?.visible).not.toBe(false);
    expect(eventPagePuckConfig.components.ProductAddOns).toBeDefined();
  });

  it('gates custom embed editing behind unsafe-content permission', () => {
    const restricted = createEventPagePuckConfig({
      allowUnsafeEmbeds: false,
    }).components.CustomEmbed.fields as unknown as Record<string, { visible?: boolean }>;
    expect(restricted.html?.visible).toBe(false);
    expect(restricted.allowUnsafeEmbed?.visible).toBe(false);

    const permitted = createEventPagePuckConfig({
      allowUnsafeEmbeds: true,
    }).components.CustomEmbed.fields as unknown as Record<string, { visible?: boolean }>;
    expect(permitted.html?.visible).not.toBe(false);
    expect(permitted.allowUnsafeEmbed?.visible).not.toBe(false);
  });

  it('keeps every event-header setting inside a navigable group', () => {
    const fieldNames = Object.keys(eventPagePuckConfig.components.EventHeader.fields ?? {});
    expect(fieldNames.indexOf('_sectionVisibility')).toBeLessThan(
      fieldNames.indexOf('showBrandBadge'),
    );
  });

  it('uses collapsed groups instead of a second advanced-styling gate', () => {
    const headerFields = eventPagePuckConfig.components.EventHeader.fields;
    expect(headerFields?.showAdvanced).toEqual(
      expect.objectContaining({ type: 'custom', visible: false }),
    );
    const resolveFields = eventPagePuckConfig.components.EventHeader.resolveFields as unknown as (
      data: { props: { id: string; showAdvanced: boolean } },
      params: { fields: Record<string, unknown> },
    ) => Record<string, unknown>;
    const resolved = resolveFields(
      { props: { id: 'header', showAdvanced: false } },
      { fields: headerFields as Record<string, unknown> },
    );
    expect(resolved).toHaveProperty('_sectionImageFine');
    expect(resolved).toHaveProperty('_sectionTitleStyle');
    expect(resolved).toHaveProperty('_sectionBadgeStyle');
  });

  it('renders product add-ons separately from event tickets', () => {
    render(
      <EventPageRuntimeProvider
        value={{
          brandName: 'Tixkit',
          brandFooterLabel: 'Powered by Tixkit',
          tickets: [
            {
              id: 'ticket-1',
              name: 'General admission',
              priceLabel: '$25',
              status: 'active',
            },
          ],
          products: [
            {
              id: 'product-1',
              name: 'Parking pass',
              priceLabel: '$10',
              status: 'active',
            },
          ],
          interactive: true,
        }}
      >
        <ProductAddOnsBlock id="addons" title="Add-ons" />
      </EventPageRuntimeProvider>,
    );

    expect(screen.getByText('Parking pass')).toBeVisible();
    expect(screen.queryByText('General admission')).not.toBeInTheDocument();
    expect(screen.getByText('Add-ons').closest('section')).toHaveAttribute(
      'data-block-type',
      'ProductAddOns',
    );
  });

  it('uploads event header logos directly from the add logo control', async () => {
    const changes: unknown[] = [];
    const config = createEventPagePuckConfig({
      onUploadImage: async () => ({
        url: 'https://assets.example.test/header-logo.png',
      }),
    });
    const field = config.components.EventHeader.fields?.logos as unknown as {
      label?: string;
      render: (props: {
        field: { label?: string };
        id: string;
        name: string;
        value: unknown[];
        onChange: (value: unknown) => void;
      }) => ReactElement;
    };

    const { container } = render(
      field.render({
        field,
        id: 'event-header-logos',
        name: 'logos',
        value: [],
        onChange: (value) => changes.push(value),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add logo' }));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, {
      target: {
        files: [new File(['logo'], 'venue.svg', { type: 'image/svg+xml' })],
      },
    });

    await waitFor(() => {
      expect(changes).toEqual([
        [
          {
            name: 'venue',
            imageUrl: 'https://assets.example.test/header-logo.png',
            imageAlt: 'venue',
            url: '',
          },
        ],
      ]);
    });
  });

  it('keeps image upload failures visible beside the affected field', async () => {
    const config = createEventPagePuckConfig({
      onUploadImage: async () => {
        throw new Error('Image storage unavailable');
      },
    });
    const field = config.components.Media.fields?.imageUrl as unknown as {
      label?: string;
      render: (props: {
        field: { label?: string };
        id: string;
        name: string;
        value: string;
        onChange: (value: string) => void;
      }) => ReactElement;
    };
    const { container } = render(
      field.render({
        field,
        id: 'media-image-upload-error',
        name: 'imageUrl',
        value: '',
        onChange: () => undefined,
      }),
    );

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, {
      target: {
        files: [new File(['image'], 'venue.png', { type: 'image/png' })],
      },
    });

    expect(await screen.findByText('Image storage unavailable')).toBeVisible();
  });

  it('dispatches image canvas edits on the canvas document', async () => {
    const ownerEvents: unknown[] = [];
    const parentEvents: unknown[] = [];
    globalThis.document.addEventListener('tixkit:event-page-hero-image-edit', (event: Event) =>
      parentEvents.push((event as CustomEvent).detail),
    );
    // oxlint-disable-next-line react/iframe-missing-sandbox -- DOM construction requires applying the sandbox immediately after creation.
    const iframe = globalThis.document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-same-origin');
    globalThis.document.body.append(iframe);
    const ownerDocument = iframe.contentDocument;
    if (!ownerDocument) throw new Error('iframe document unavailable');
    ownerDocument.addEventListener('tixkit:event-page-hero-image-edit', (event: Event) =>
      ownerEvents.push((event as CustomEvent).detail),
    );
    const host = ownerDocument.createElement('div');
    ownerDocument.body.append(host);

    render(
      <EventPageRuntimeProvider
        value={{
          brandName: 'Tixkit',
          brandFooterLabel: 'Powered by Tixkit',
          tickets: [],
          interactive: false,
        }}
      >
        <EventDescriptionBlock
          id="description-owner-document"
          title="Description"
          imageUrl="https://assets.example.test/hero.jpg"
          imageFit="cover"
          imagePlacement={{ x: '50%', y: '50%', scale: '1' }}
          puck={{ isEditing: true }}
        />
      </EventPageRuntimeProvider>,
      { container: host, baseElement: ownerDocument.body },
    );

    fireEvent.click(
      ownerDocument.body.querySelector('[aria-label="Edit image placement"]') as HTMLElement,
    );
    fireEvent.click(ownerDocument.body.querySelector('.tk-ep-image-editor__chip')!);

    await waitFor(() => {
      expect(ownerEvents).toEqual([
        {
          id: 'description-owner-document',
          blockType: 'EventDescription',
          placement: { x: '50%', y: '50%', scale: '1' },
        },
      ]);
    });
    expect(parentEvents).toEqual([]);
  });

  it('exposes design controls and upload-capable media fields in the Puck schema', () => {
    const config = createEventPagePuckConfig({
      onUploadImage: async () => ({
        url: 'https://assets.example.test/uploaded.png',
      }),
    });

    expect(config.components.Button.fields).toEqual(
      expect.objectContaining({
        label: expect.objectContaining({ type: 'text' }),
        url: expect.objectContaining({ type: 'custom' }),
        style: expect.objectContaining({ type: 'custom' }),
        alignment: expect.objectContaining({ type: 'custom' }),
        size: expect.objectContaining({ type: 'custom' }),
        width: expect.objectContaining({ type: 'custom' }),
        radius: expect.objectContaining({ type: 'custom' }),
        textStyle: expect.objectContaining({ type: 'custom' }),
        backgroundColor: expect.objectContaining({ type: 'custom' }),
        textColor: expect.objectContaining({ type: 'custom' }),
        borderColor: expect.objectContaining({ type: 'custom' }),
        openInNewTab: expect.objectContaining({ type: 'custom' }),
        fontSize: expect.objectContaining({ type: 'custom' }),
        lineHeight: expect.objectContaining({ type: 'custom' }),
        letterSpacing: expect.objectContaining({ type: 'custom' }),
        paddingX: expect.objectContaining({ type: 'custom' }),
        paddingY: expect.objectContaining({ type: 'custom' }),
        minHeight: expect.objectContaining({ type: 'custom' }),
        borderWidth: expect.objectContaining({ type: 'custom' }),
        customRadius: expect.objectContaining({ type: 'custom' }),
        showAdvanced: expect.objectContaining({ type: 'custom' }),
      }),
    );
    expect(config.components.RichText.fields).toEqual(
      expect.objectContaining({
        alignment: expect.objectContaining({ type: 'custom' }),
        textSize: expect.objectContaining({ type: 'custom' }),
        spacing: expect.objectContaining({ type: 'custom' }),
        sectionStyle: expect.objectContaining({ type: 'custom' }),
        fontSize: expect.objectContaining({ type: 'custom' }),
        lineHeight: expect.objectContaining({ type: 'custom' }),
        paragraphGap: expect.objectContaining({ type: 'custom' }),
        showAdvanced: expect.objectContaining({ type: 'custom' }),
      }),
    );
    expect(config.components.EventDescription.fields).toEqual(
      expect.objectContaining({
        alignment: expect.objectContaining({ label: 'Section align' }),
        titleAlignment: expect.objectContaining({ label: 'Title align' }),
        bodyAlignment: expect.objectContaining({ label: 'Body align' }),
        imageAlignment: expect.objectContaining({ label: 'Image align' }),
        backgroundColor: expect.objectContaining({ type: 'custom' }),
        imageLayout: expect.objectContaining({ label: 'Image mode' }),
        imageFit: expect.objectContaining({
          label: 'Image fit',
          visible: false,
        }),
        imagePosition: expect.objectContaining({
          label: 'Image anchor',
          visible: false,
        }),
        imagePlacement: expect.objectContaining({
          label: 'Image placement',
          visible: false,
        }),
        logos: expect.objectContaining({ label: 'Logos', type: 'custom' }),
        logoPosition: expect.objectContaining({
          type: 'custom',
          label: 'Placement',
        }),
        logoMaxHeight: expect.objectContaining({
          type: 'custom',
          label: 'Logo height',
        }),
        logoMaxWidth: expect.objectContaining({
          type: 'custom',
          label: 'Logo width',
        }),
        overlayContentPosition: expect.objectContaining({ type: 'custom' }),
        overlayContentHorizontalPosition: expect.objectContaining({
          type: 'custom',
        }),
        overlayMinHeight: expect.objectContaining({ type: 'custom' }),
        overlayPadding: expect.objectContaining({ type: 'custom' }),
        imageOpacity: expect.objectContaining({ type: 'custom' }),
        backgroundOverlayColor: expect.objectContaining({ type: 'custom' }),
        backgroundOverlayOpacity: expect.objectContaining({ type: 'custom' }),
        imageOverlay: expect.objectContaining({
          label: 'Extra overlay content',
        }),
        eyebrowColor: expect.objectContaining({ label: 'Eyebrow color' }),
        titleColor: expect.objectContaining({ label: 'Title color' }),
        bodyColor: expect.objectContaining({ label: 'Body color' }),
        contentBackgroundColor: expect.objectContaining({
          label: 'Panel background',
        }),
        contentPadding: expect.objectContaining({ label: 'Panel padding' }),
        contentRadius: expect.objectContaining({ label: 'Panel radius' }),
        titleFontSize: expect.objectContaining({ type: 'custom' }),
        bodyFontSize: expect.objectContaining({ type: 'custom' }),
        showAdvanced: expect.objectContaining({ type: 'custom' }),
      }),
    );
    expect(config.components.Tickets.fields).toEqual(
      expect.objectContaining({
        alignment: expect.objectContaining({ label: 'Align' }),
        spacing: expect.objectContaining({ label: 'Section padding' }),
        previewState: expect.objectContaining({ label: 'Preview data' }),
        titleFontSize: expect.objectContaining({ label: 'Title size' }),
        titleColor: expect.objectContaining({ label: 'Title color' }),
        sectionGap: expect.objectContaining({ label: 'Title gap' }),
        itemGap: expect.objectContaining({ label: 'List gap' }),
        itemPadding: expect.objectContaining({ label: 'Card padding' }),
        itemRadius: expect.objectContaining({ label: 'Card radius' }),
        itemBackgroundColor: expect.objectContaining({
          label: 'Card background',
        }),
        itemBorderColor: expect.objectContaining({ label: 'Card border' }),
        itemTextColor: expect.objectContaining({ label: 'Card text' }),
        itemDescriptionColor: expect.objectContaining({
          label: 'Description color',
        }),
        priceTextColor: expect.objectContaining({ label: 'Price color' }),
        emptyBackgroundColor: expect.objectContaining({
          label: 'Empty background',
        }),
        emptyBorderColor: expect.objectContaining({ label: 'Empty border' }),
        showAdvanced: expect.objectContaining({ type: 'custom' }),
      }),
    );
    expect(config.components.ResaleTickets.fields).toEqual(
      expect.objectContaining({
        previewState: expect.objectContaining({ label: 'Canvas state' }),
      }),
    );

    const imageField = config.components.Media.fields?.imageUrl as unknown as {
      label?: string;
      render: (props: {
        field: { label?: string };
        id: string;
        name: string;
        value: string;
        onChange: (value: string) => void;
      }) => ReactElement;
    };

    render(
      imageField.render({
        field: imageField,
        id: 'media-image-url',
        name: 'imageUrl',
        value: '',
        onChange: () => undefined,
      }),
    );

    expect(screen.getByText('Upload image')).toBeInTheDocument();

    const changes: string[] = [];
    render(
      imageField.render({
        field: imageField,
        id: 'media-image-url-remove',
        name: 'imageUrl',
        value: 'https://assets.example.test/current.png',
        onChange: (value) => changes.push(value),
      }),
    );

    expect(screen.getByText('Change image')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(changes).toEqual(['']);
  });

  it('keeps description overlay content editable until image placement mode is opened', () => {
    const config = createEventPagePuckConfig();
    expect(config.components.EventDescription.fields?.imagePlacement).toEqual(
      expect.objectContaining({ visible: false }),
    );
    expect(config.components.EventDescription.fields?.imageFit).toEqual(
      expect.objectContaining({ visible: false }),
    );

    const events: Array<CustomEvent> = [];
    const overlayClicks: string[] = [];
    const handler = (event: Event) => events.push(event as CustomEvent);
    window.document.addEventListener('tixkit:event-page-hero-image-edit', handler);

    render(
      <EventPageRuntimeProvider
        value={{
          interactive: false,
          brandName: 'Tixkit',
          brandFooterLabel: 'Powered by Tixkit',
          tickets: [],
        }}
      >
        <EventDescriptionBlock
          id="description-canvas-edit"
          title="Canvas placement"
          imageUrl="https://assets.example.test/hero.jpg"
          imageAlt="Hero"
          imageFit="cover"
          imagePlacement={{ x: '50%', y: '50%', scale: '1' }}
          imageLayout="background"
          overlayContentPosition="bottom"
          imageOverlay={({ className }: { className: string }) => (
            <div className={className}>
              <button type="button" onClick={() => overlayClicks.push('clicked')}>
                Style overlay button
              </button>
            </div>
          )}
          puck={{ isEditing: true }}
        />
      </EventPageRuntimeProvider>,
    );

    const imageEditor = screen.getByTestId('hero-image-canvas-editor');
    expect(imageEditor).toBeInTheDocument();
    expect(imageEditor).not.toHaveAttribute('data-puck-overlay-portal');
    const editImageButton = screen.getByRole('button', {
      name: 'Edit image placement',
    });
    expect(editImageButton).toBeInTheDocument();
    expect(editImageButton).toHaveAttribute('data-puck-overlay-portal', 'true');
    expect(screen.queryByRole('slider', { name: 'Image zoom' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Style overlay button' }));
    expect(overlayClicks).toEqual(['clicked']);
    expect(events).toEqual([]);

    fireEvent.click(editImageButton);
    expect(screen.getByRole('slider', { name: 'Image zoom' })).toBeInTheDocument();
    expect(imageEditor.querySelector('.tk-ep-image-editor__active-layer')).toHaveAttribute(
      'data-puck-overlay-portal',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Top right' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Image zoom' }), {
      target: { value: '1.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Contain' }));
    // Toolbar remains interactive while the hit surface is present, then returns to overlay editing.
    expect(screen.getByRole('button', { name: 'Reset' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('slider', { name: 'Image zoom' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Style overlay button' }));
    expect(overlayClicks).toEqual(['clicked', 'clicked']);

    window.document.removeEventListener('tixkit:event-page-hero-image-edit', handler);

    expect(events.map((event) => event.detail)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'description-canvas-edit',
          placement: { x: '100%', y: '0%', scale: '1' },
        }),
        expect.objectContaining({
          id: 'description-canvas-edit',
          placement: { x: '50%', y: '50%', scale: '1.5' },
        }),
        expect.objectContaining({
          id: 'description-canvas-edit',
          imageFit: 'contain',
        }),
      ]),
    );
  });

  it('hides ticket empty-state controls unless the canvas is rendering an empty state', () => {
    const withCommerce = createEventPagePuckConfig({ hasCommerceItems: true });
    const withoutCommerce = createEventPagePuckConfig({
      hasCommerceItems: false,
    });
    const commerceFields = withCommerce.components.Tickets.fields;
    const emptyCommerceFields = withoutCommerce.components.Tickets.fields;
    const resolveWithCommerce = withCommerce.components.Tickets.resolveFields;
    const resolveWithoutCommerce = withoutCommerce.components.Tickets.resolveFields;

    expect(commerceFields).toBeDefined();
    expect(emptyCommerceFields).toBeDefined();
    expect(resolveWithCommerce).toBeTypeOf('function');
    expect(resolveWithoutCommerce).toBeTypeOf('function');
    if (
      !commerceFields ||
      !emptyCommerceFields ||
      !resolveWithCommerce ||
      !resolveWithoutCommerce
    ) {
      throw new Error('Tickets fields and resolver are required for this test.');
    }

    const commonParams = {
      fields: commerceFields,
      lastFields: commerceFields,
      changed: {},
      lastData: null,
      metadata: {},
      appState: {} as never,
      parent: null,
    };
    const liveFields = resolveWithCommerce(
      { props: { id: 'tickets', previewState: 'live' } },
      commonParams,
    );
    const populatedFields = resolveWithCommerce(
      { props: { id: 'tickets', previewState: 'populated' } },
      commonParams,
    );
    const forcedEmptyFields = resolveWithCommerce(
      { props: { id: 'tickets', previewState: 'empty' } },
      commonParams,
    );
    const liveEmptyFields = resolveWithoutCommerce(
      { props: { id: 'tickets', previewState: 'live' } },
      {
        ...commonParams,
        fields: emptyCommerceFields,
        lastFields: emptyCommerceFields,
      },
    );

    expect(liveFields).not.toHaveProperty('emptyTitle');
    expect(liveFields).not.toHaveProperty('emptyDescription');
    expect(liveFields).not.toHaveProperty('emptyBackgroundColor');
    expect(liveFields).not.toHaveProperty('emptyBorderColor');
    expect(populatedFields).not.toHaveProperty('emptyTitle');
    expect(forcedEmptyFields).toHaveProperty('emptyTitle');
    expect(forcedEmptyFields).toHaveProperty('emptyBackgroundColor');
    expect(liveEmptyFields).toHaveProperty('emptyTitle');
    expect(liveEmptyFields).toHaveProperty('emptyBorderColor');

    const advancedEmptyFields = resolveWithCommerce(
      {
        props: {
          id: 'tickets',
          previewState: 'empty',
          showAdvanced: true,
        } as never,
      },
      commonParams,
    );
    expect(advancedEmptyFields).toHaveProperty('emptyBackgroundColor');
    expect(advancedEmptyFields).toHaveProperty('emptyBorderColor');
  });

  it('exposes a component type guard', () => {
    expect(isEventPagePuckComponentType('Hero')).toBe(false);
    expect(isEventPagePuckComponentType('EventDescription')).toBe(true);
    expect(isEventPagePuckComponentType('tickets')).toBe(false);
  });
});

describe('EventPageRender', () => {
  it('renders exact sub-element styles for buttons and event detail labels', () => {
    render(
      <>
        <ButtonBlock
          id="button-1"
          label="Buy now"
          url="https://example.test"
          fontSize="18px"
          paddingX="24px"
          paddingY="12px"
          minHeight="52px"
          borderWidth="2px"
          customRadius="18px"
          letterSpacing="1px"
          lineHeight="1.2"
          backgroundColor="#2563eb"
          textColor="#ffffff"
          borderColor="#111827"
        />
        <EventDetailsBlock
          id="details-1"
          title="Event details"
          items={[{ label: 'Starts', value: '7 PM' }]}
          titleFontSize="30px"
          titleColor="#2563eb"
          labelFontSize="12px"
          valueFontSize="16px"
          labelColor="#64748b"
          valueColor="#111827"
        />
      </>,
    );

    const button = screen.getByRole('link', { name: 'Buy now' });
    expect(button).toHaveStyle({
      fontSize: '18px',
      paddingInline: '24px',
      paddingBlock: '12px',
      minHeight: '52px',
      borderWidth: '2px',
      borderRadius: '18px',
      letterSpacing: '1px',
      lineHeight: '1.2',
      backgroundColor: '#2563eb',
      color: '#ffffff',
      borderColor: '#111827',
    });
    expect(screen.getByRole('heading', { name: 'Event details' })).toHaveStyle({
      fontSize: '30px',
      color: '#2563eb',
    });
    expect(screen.getByText('Starts')).toHaveStyle({
      fontSize: '12px',
      color: '#64748b',
    });
    expect(screen.getByText('7 PM')).toHaveStyle({
      fontSize: '16px',
      color: '#111827',
    });
  });

  it('renders description logos over the background image', () => {
    render(
      <EventPageRuntimeProvider
        value={{
          interactive: true,
          brandName: 'Tixkit',
          brandFooterLabel: 'Powered by Tixkit',
          tickets: [],
        }}
      >
        <EventDescriptionBlock
          id="description-logos"
          title="Logo description"
          imageUrl="https://assets.example.test/hero.jpg"
          imageAlt="Hero"
          imageLayout="background"
          logos={[
            {
              name: 'Partner',
              imageUrl: 'https://assets.example.test/logo.svg',
              imageAlt: 'Partner logo',
              url: 'https://partner.example.test',
            },
          ]}
          logoPosition="top-right"
          logoSize="lg"
          logoMaxHeight="56px"
          logoMaxWidth="180px"
        />
      </EventPageRuntimeProvider>,
    );

    const logos = screen.getByRole('list', { name: 'Description logos' });
    expect(logos).toHaveClass('tk-ep-hero__logos--top-right');
    expect(logos).toHaveClass('tk-ep-hero__logos--lg');
    expect(logos).toHaveStyle({
      '--tk-ep-logo-max-height': '56px',
      '--tk-ep-logo-max-width': '180px',
    });
    expect(screen.getByRole('img', { name: 'Partner logo' })).toHaveAttribute(
      'src',
      'https://assets.example.test/logo.svg',
    );
    expect(screen.getByRole('link', { name: 'Partner logo' })).toHaveAttribute(
      'href',
      'https://partner.example.test',
    );
  });

  it('uses a placement grid and alignment icons instead of chip badges', () => {
    const config = createEventPagePuckConfig();
    const placement = config.components.EventDescription.fields?.logoPosition as unknown as {
      label?: string;
      render: (props: {
        field: { label?: string };
        id: string;
        name: string;
        value: string;
        onChange: (value: string) => void;
      }) => ReactElement;
    };
    const alignment = config.components.EventDescription.fields?.titleAlignment as unknown as {
      label?: string;
      render: (props: {
        field: { label?: string };
        id: string;
        name: string;
        value: string;
        onChange: (value: string) => void;
      }) => ReactElement;
    };
    const placementChanges: string[] = [];
    const alignmentChanges: string[] = [];

    const { unmount } = render(
      placement.render({
        field: placement,
        id: 'logo-position',
        name: 'logoPosition',
        value: 'top-left',
        onChange: (value) => placementChanges.push(value),
      }),
    );
    fireEvent.click(screen.getByTitle('Top right'));
    expect(placementChanges).toEqual(['top-right']);
    unmount();

    render(
      alignment.render({
        field: alignment,
        id: 'title-align',
        name: 'titleAlignment',
        value: 'left',
        onChange: (value) => alignmentChanges.push(value),
      }),
    );
    fireEvent.click(screen.getByTitle('Center'));
    expect(alignmentChanges).toEqual(['center']);
  });

  it('renders description element alignment and image overlay slots', () => {
    const data: EventPagePuckData = {
      root: { props: { title: 'Overlay page' } },
      content: [
        {
          type: 'EventDescription',
          props: {
            id: 'description-overlay',
            title: 'Overlay headline',
            body: 'Overlay body',
            imageUrl: 'https://assets.example.test/hero.jpg',
            imageAlt: 'Hero',
            alignment: 'left',
            titleAlignment: 'center',
            bodyAlignment: 'right',
            backgroundColor: '#101827',
            imageLayout: 'background',
            imageFit: 'contain',
            imagePosition: 'top',
            imagePlacement: { x: '35%', y: '40%', scale: '1.4' },
            overlayContentPosition: 'bottom',
            overlayMinHeight: '420px',
            overlayPadding: '32px',
            imageOpacity: '0.6',
            backgroundOverlayColor: '#111827',
            backgroundOverlayOpacity: '0.5',
            titleColor: '#f8fafc',
            bodyColor: '#dbeafe',
            contentBackgroundColor: '#111827',
            contentPadding: '24px',
            contentRadius: '18px',
            imageOverlay: [
              {
                type: 'Button',
                props: {
                  id: 'overlay-button',
                  label: 'Overlay CTA',
                  url: '#tickets',
                  alignment: 'center',
                },
              },
            ],
          },
        },
      ],
    };

    const { container } = render(<EventPageRender data={data} validate={false} />);

    expect(container.querySelector('.tk-ep-event-description--background')).toBeInTheDocument();
    expect(container.querySelector('.tk-ep-event-description')).toHaveStyle({
      backgroundColor: '#101827',
    });
    expect(container.querySelector('.tk-ep-event-description__overlay')).toHaveStyle({
      minHeight: '420px',
      padding: '32px',
      '--tk-ep-image-opacity': '0.6',
      '--tk-ep-overlay-color': '#111827',
      '--tk-ep-overlay-opacity': '0.5',
    });
    expect(container.querySelector('.tk-ep-overlay-image')).toHaveStyle({
      objectFit: 'contain',
      objectPosition: '35% 40%',
      transform: 'scale(1.4)',
      transformOrigin: '35% 40%',
    });
    expect(screen.getByRole('heading', { name: 'Overlay headline' })).toHaveStyle({
      textAlign: 'center',
      color: '#f8fafc',
    });
    expect(container.querySelector('.tk-ep-event-description__copy')).toHaveStyle({
      backgroundColor: '#111827',
      padding: '24px',
      borderRadius: '18px',
    });
    expect(screen.getByText('Overlay body')).toHaveStyle({
      textAlign: 'right',
      color: '#dbeafe',
    });
    expect(screen.getByRole('link', { name: 'Overlay CTA' })).toBeInTheDocument();
  });

  it('renders event header background image overlay and logo settings', () => {
    const data: EventPagePuckData = {
      root: { props: { title: 'Header overlay page' } },
      content: [
        {
          type: 'EventHeader',
          props: {
            id: 'event-header-overlay',
            brandLabel: 'All Access',
            title: 'Header headline',
            description: 'Header body',
            startsAtLabel: 'Jul 17, 2026',
            timezone: 'America/Chicago',
            venueName: 'The Salt Shed',
            showDate: true,
            showTimezone: true,
            showVenue: true,
            showBrandBadge: true,
            imageUrl: 'https://assets.example.test/header.jpg',
            imageAlt: 'Header',
            imageFit: 'contain',
            imagePosition: 'top',
            imagePlacement: { x: '25%', y: '35%', scale: '1.25' },
            overlayContentPosition: 'bottom',
            overlayContentHorizontalPosition: 'center',
            overlayMinHeight: '460px',
            overlayPadding: '36px',
            contentPadding: '20px',
            contentGap: '18px',
            imageOpacity: '0.7',
            backgroundOverlayColor: '#020617',
            backgroundOverlayOpacity: '0.45',
            logos: [
              {
                name: 'Venue logo',
                imageUrl: 'https://assets.example.test/logo.png',
                imageAlt: 'Venue',
                url: 'https://venue.example.test',
              },
            ],
            logoPosition: 'bottom-right',
            logoSize: 'lg',
            logoMaxHeight: '52px',
            logoMaxWidth: '180px',
            titleFontSize: '64px',
            titleColor: '#f8fafc',
            descriptionFontSize: '20px',
            descriptionColor: '#dbeafe',
            metaFontSize: '15px',
            metaColor: '#e2e8f0',
            metaIconColor: '#38bdf8',
            metaGap: '22px',
            badgeFontSize: '13px',
            badgeTextColor: '#ffffff',
            badgeBackgroundColor: '#0f172a',
            badgeBorderColor: '#38bdf8',
          },
        },
      ],
    };

    const { container } = render(<EventPageRender data={data} validate={false} />);

    expect(container.querySelector('.tk-ep-event-header--background')).toBeInTheDocument();
    expect(container.querySelector('.tk-ep-event-header__overlay')).toHaveStyle({
      minHeight: '460px',
      padding: '36px',
      '--tk-ep-image-opacity': '0.7',
      '--tk-ep-overlay-color': '#020617',
      '--tk-ep-overlay-opacity': '0.45',
    });
    expect(container.querySelector('.tk-ep-overlay-content')).toHaveClass(
      'tk-ep-overlay-align-center',
    );
    expect(container.querySelector('.tk-ep-overlay-image')).toHaveStyle({
      objectFit: 'contain',
      objectPosition: '25% 35%',
      transform: 'scale(1.25)',
      transformOrigin: '25% 35%',
    });
    expect(container.querySelector('.tk-ep-event-header__content')).toHaveStyle({
      padding: '20px',
      gap: '18px',
    });
    expect(screen.getByRole('heading', { name: 'Header headline' })).toHaveStyle({
      fontSize: '64px',
      color: '#f8fafc',
    });
    expect(screen.getByText('Header body')).toHaveStyle({
      fontSize: '20px',
      color: '#dbeafe',
    });
    expect(screen.getByText('Jul 17, 2026').closest('dl')).toHaveStyle({
      fontSize: '15px',
      color: '#e2e8f0',
      gap: '22px',
    });
    expect(screen.getByText('All Access')).toHaveStyle({
      fontSize: '13px',
      color: '#ffffff',
      backgroundColor: '#0f172a',
      borderColor: '#38bdf8',
    });
    const logoList = screen.getByRole('list', { name: 'Event header logos' });
    expect(logoList).toHaveClass('tk-ep-hero__logos--bottom-right');
    expect(logoList).toHaveClass('tk-ep-hero__logos--lg');
    expect(logoList).toHaveStyle({
      '--tk-ep-logo-max-height': '52px',
      '--tk-ep-logo-max-width': '180px',
    });
    expect(screen.getByRole('link', { name: 'Venue' })).toHaveAttribute(
      'href',
      'https://venue.example.test',
    );
  });

  it('renders event description body with background image overlay and logos', () => {
    const data: EventPagePuckData = {
      root: { props: { title: 'Description overlay page' } },
      content: [
        {
          type: 'EventDescription',
          props: {
            id: 'event-description-overlay',
            eyebrow: 'Inside the night',
            title: 'About All Access',
            body: 'A longer editorial body for the event page.',
            imageUrl: 'https://assets.example.test/description.jpg',
            imageAlt: 'Description',
            imageLayout: 'background',
            imageFit: 'contain',
            imagePlacement: { x: '30%', y: '45%', scale: '1.3' },
            overlayContentPosition: 'top',
            overlayContentHorizontalPosition: 'right',
            overlayMinHeight: '380px',
            overlayPadding: '28px',
            imageOpacity: '0.65',
            backgroundOverlayColor: '#111827',
            backgroundOverlayOpacity: '0.5',
            contentPadding: '22px',
            contentGap: '16px',
            contentBackgroundColor: 'rgba(15, 23, 42, 0.72)',
            contentRadius: '18px',
            titleColor: '#f8fafc',
            bodyColor: '#dbeafe',
            logos: [
              {
                name: 'Partner logo',
                imageUrl: 'https://assets.example.test/partner.png',
                imageAlt: 'Partner',
              },
            ],
            logoPosition: 'top-right',
            logoSize: 'md',
            logoMaxHeight: '44px',
            logoMaxWidth: '140px',
          },
        },
      ],
    };

    const { container } = render(<EventPageRender data={data} validate={false} />);

    expect(container.querySelector('.tk-ep-event-description--background')).toBeInTheDocument();
    expect(container.querySelector('.tk-ep-event-description__overlay')).toHaveStyle({
      minHeight: '380px',
      padding: '28px',
      '--tk-ep-image-opacity': '0.65',
      '--tk-ep-overlay-color': '#111827',
      '--tk-ep-overlay-opacity': '0.5',
    });
    expect(container.querySelector('.tk-ep-overlay-content')).toHaveClass(
      'tk-ep-overlay-align-right',
    );
    expect(container.querySelector('.tk-ep-overlay-image')).toHaveStyle({
      objectFit: 'contain',
      objectPosition: '30% 45%',
      transform: 'scale(1.3)',
      transformOrigin: '30% 45%',
    });
    expect(container.querySelector('.tk-ep-event-description__copy')).toHaveStyle({
      padding: '22px',
      gap: '16px',
      backgroundColor: 'rgba(15, 23, 42, 0.72)',
      borderRadius: '18px',
    });
    expect(screen.getByRole('heading', { level: 2, name: 'About All Access' })).toHaveStyle({
      color: '#f8fafc',
    });
    expect(screen.getByText('A longer editorial body for the event page.')).toHaveStyle({
      color: '#dbeafe',
    });
    const logoList = screen.getByRole('list', { name: 'Description logos' });
    expect(logoList).toHaveClass('tk-ep-hero__logos--top-right');
    expect(logoList).toHaveStyle({
      '--tk-ep-logo-max-height': '44px',
      '--tk-ep-logo-max-width': '140px',
    });
    expect(screen.getByRole('img', { name: 'Partner' })).toBeInTheDocument();
  });

  it('removes the event header badge when the badge toggle is disabled', () => {
    const data: EventPagePuckData = {
      root: { props: { title: 'Header page' } },
      content: [
        {
          type: 'EventHeader',
          props: {
            id: 'event-header-no-badge',
            brandLabel: 'Hidden brand',
            title: 'Header without badge',
            showBrandBadge: false,
            showDate: false,
            showTimezone: false,
            showVenue: false,
          },
        },
      ],
    };

    const { container } = render(<EventPageRender data={data} validate={false} />);

    expect(screen.getByRole('heading', { name: 'Header without badge' })).toBeInTheDocument();
    expect(screen.queryByText('Hidden brand')).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="badge"]')).not.toBeInTheDocument();
  });

  it('uses editor-only preview states for tickets and resale tickets', () => {
    const runtime = {
      brandName: 'Tixkit',
      brandFooterLabel: 'Powered by Tixkit',
      tickets: [],
      resaleListings: [],
      interactive: false,
    };

    const { rerender } = render(
      <EventPageRuntimeProvider value={runtime}>
        <TicketsBlock
          id="tickets"
          title="Tickets"
          previewState="populated"
          emptyTitle="No tickets available"
          emptyDescription="Ticket sales have not opened."
          itemBackgroundColor="#f8fafc"
          itemBorderColor="#2563eb"
          itemTextColor="#111827"
          itemDescriptionColor="#475569"
          priceTextColor="#2563eb"
          itemPadding="18px"
          itemRadius="16px"
        />
        <ResaleTicketsBlock id="resale" title="Resale tickets" previewState="live" />
      </EventPageRuntimeProvider>,
    );

    expect(screen.getByText('General Admission')).toBeInTheDocument();
    expect(screen.getByText('General Admission').closest('[data-slot="card"]')).toHaveStyle({
      backgroundColor: '#f8fafc',
      borderColor: '#2563eb',
      color: '#111827',
      padding: '18px',
      borderRadius: '16px',
    });
    expect(screen.getByText('Example ticket shown only in the editor canvas.')).toHaveStyle({
      color: '#475569',
    });
    expect(screen.getByText('Free')).toHaveStyle({ color: '#2563eb' });
    expect(screen.getByText('Resale tickets')).toHaveClass('sr-only');

    rerender(
      <EventPageRuntimeProvider value={runtime}>
        <TicketsBlock
          id="tickets"
          title="Tickets"
          previewState="empty"
          emptyTitle="No tickets available"
          emptyDescription="Ticket sales have not opened."
        />
        <ResaleTicketsBlock id="resale" title="Resale tickets" previewState="empty" />
      </EventPageRuntimeProvider>,
    );

    expect(screen.getByText('No tickets available')).toBeInTheDocument();
    expect(screen.getByText('No resale listings available yet.')).toBeInTheDocument();

    rerender(
      <EventPageRuntimeProvider value={runtime}>
        <TicketsBlock
          id="tickets"
          title="Tickets"
          previewState="live"
          emptyTitle="No tickets available"
          emptyDescription="Ticket sales have not opened."
        />
        <ResaleTicketsBlock id="resale" title="Resale tickets" previewState="populated" />
      </EventPageRuntimeProvider>,
    );

    expect(screen.getByText('No tickets available')).toBeInTheDocument();
    expect(screen.getByText('Resale ticket - General Admission')).toBeInTheDocument();
  });

  it('renders Puck data with the isolated style scope and brand variables', () => {
    const { container } = render(
      <EventPageRender
        document={document}
        brandVariables={{
          background: '#101010',
          foreground: '#ffffff',
          accent: '#ffcc00',
        }}
      />,
    );

    const scope = container.querySelector(`.${EVENT_PAGE_PUCK_STYLES_CLASS}`) as HTMLElement | null;
    expect(scope).not.toBeNull();
    expect(scope?.dataset.provider).toBe('@puckeditor/core');
    expect(scope?.style.getPropertyValue('--tk-brand-bg')).toBe('#101010');
    expect(scope?.style.getPropertyValue('--tk-brand-fg')).toBe('#ffffff');
    expect(scope?.style.getPropertyValue('--tk-brand-accent')).toBe('#ffcc00');
    const page = container.querySelector('.tixkit-event-page') as HTMLElement | null;
    expect(page?.dataset.pageTitle).toBe('All Access Chicago');
    expect(page?.dataset.pageDescription).toBe('A full night of music and access.');
    // Default body is the full public chrome composition (h1 + tickets/cta/footer).
    expect(document.editor.data.content.map((block) => block.type)).toEqual([
      'EventHeader',
      'EventDescription',
      'Divider',
      'Tickets',
      'ResaleTickets',
      'CheckoutCta',
      'BrandFooter',
    ]);
    expect(
      screen.getByRole('heading', { level: 1, name: 'All Access Chicago' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Tickets' })).toBeInTheDocument();
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
    expect(
      createEventPageRenderStyle({
        accentForeground: '#000000',
        radius: '6px',
      }),
    ).toEqual({
      '--tk-brand-accent-fg': '#000000',
      '--tk-brand-radius': '6px',
    });
  });
});
