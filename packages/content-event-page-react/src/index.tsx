import { Render, type Config, type Data, type IframeConfig, type Metadata } from '@puckeditor/core';
import {
  EVENT_PAGE_PUCK_COMPONENT_TYPES,
  PUCK_EVENT_PAGE_PROVIDER,
  eventPageBrandVariablesToCssProperties,
  normalizeEventPageDocument,
  sanitizeEventPageHtml,
  validateEventPageDocument,
  type EventPageBrandVariables,
  type EventPageButtonProps,
  type EventPageCustomEmbedProps,
  type EventPageDetailsProps,
  type EventPageDividerProps,
  type EventPageDocument,
  type EventPageFaqProps,
  type EventPageHeroProps,
  type EventPageMediaProps,
  type EventPagePuckComponentType,
  type EventPagePuckData,
  type EventPageRichTextProps,
  type EventPageRootProps,
  type EventPageScheduleProps,
  type EventPageSocialLinksProps,
  type EventPageSpeakersProps,
  type EventPageSponsorsProps,
  type EventPageVenueProps,
  type EventPageValidationOptions,
} from '@tixkit/content-event-page';
import type { CSSProperties, ReactNode } from 'react';

export type EventPagePuckComponentProps = {
  Hero: EventPageHeroProps;
  RichText: EventPageRichTextProps;
  Media: EventPageMediaProps;
  EventDetails: EventPageDetailsProps;
  Schedule: EventPageScheduleProps;
  Venue: EventPageVenueProps;
  FAQ: EventPageFaqProps;
  Sponsors: EventPageSponsorsProps;
  Speakers: EventPageSpeakersProps;
  Button: EventPageButtonProps;
  Divider: EventPageDividerProps;
  SocialLinks: EventPageSocialLinksProps;
  CustomEmbed: EventPageCustomEmbedProps;
};

export type EventPagePuckCategory = 'hero' | 'content' | 'event' | 'people' | 'actions';
export type EventPagePuckConfig = Config<
  EventPagePuckComponentProps,
  EventPageRootProps,
  EventPagePuckCategory
>;
export type EventPagePuckCoreData = Data<EventPagePuckComponentProps, EventPageRootProps>;

type WithBlockId<T> = T & { id?: string };
type EventPageRootRenderProps = EventPageRootProps & { children?: ReactNode };

export type EventPageRenderProps = {
  document?: EventPageDocument | unknown;
  data?: EventPagePuckData | unknown;
  className?: string;
  brandVariables?: EventPageBrandVariables;
  metadata?: Metadata;
  validate?: boolean;
  validationOptions?: EventPageValidationOptions;
  fallback?: ReactNode;
};

export const EVENT_PAGE_PUCK_STYLES_CLASS = 'tixkit-event-page-puck-scope';

export const eventPagePuckIframeConfig: IframeConfig = {
  enabled: true,
  waitForStyles: true,
  syncHostStyles: false,
};

const alignmentOptions = [
  { label: 'Left', value: 'left' },
  { label: 'Center', value: 'center' },
] as const;

const buttonStyleOptions = [
  { label: 'Primary', value: 'primary' },
  { label: 'Secondary', value: 'secondary' },
  { label: 'Link', value: 'link' },
] as const;

const aspectRatioOptions = [
  { label: 'Auto', value: 'auto' },
  { label: '16:9', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '1:1', value: '1:1' },
] as const;

const dividerSpacingOptions = [
  { label: 'Compact', value: 'compact' },
  { label: 'Normal', value: 'normal' },
  { label: 'Loose', value: 'loose' },
] as const;

export const eventPagePuckConfig: EventPagePuckConfig = {
  categories: {
    hero: {
      title: 'Hero',
      components: ['Hero'],
      defaultExpanded: true,
    },
    content: {
      title: 'Content',
      components: ['RichText', 'Media', 'Button', 'Divider', 'CustomEmbed'],
      defaultExpanded: true,
    },
    event: {
      title: 'Event',
      components: ['EventDetails', 'Schedule', 'Venue', 'FAQ'],
      defaultExpanded: true,
    },
    people: {
      title: 'People',
      components: ['Speakers', 'Sponsors', 'SocialLinks'],
      defaultExpanded: false,
    },
    actions: {
      title: 'Actions',
      components: ['Button'],
      defaultExpanded: false,
    },
  },
  root: {
    fields: {
      title: { type: 'text', label: 'Page title' },
      description: { type: 'textarea', label: 'Page description' },
      backgroundColor: { type: 'text', label: 'Background color' },
      foregroundColor: { type: 'text', label: 'Text color' },
      accentColor: { type: 'text', label: 'Accent color' },
      accentForegroundColor: { type: 'text', label: 'Accent text color' },
      fontFamily: { type: 'text', label: 'Body font' },
      headingFontFamily: { type: 'text', label: 'Heading font' },
      radius: { type: 'text', label: 'Corner radius' },
    },
    defaultProps: {
      backgroundColor: '#ffffff',
      foregroundColor: '#111111',
      accentColor: '#111111',
      accentForegroundColor: '#ffffff',
      fontFamily: 'Inter, system-ui, sans-serif',
      headingFontFamily: 'Inter, system-ui, sans-serif',
      radius: '14px',
    },
    render: (props) => <EventPageRoot {...props} />,
  },
  components: {
    Hero: {
      label: 'Hero',
      fields: {
        eyebrow: { type: 'text', label: 'Eyebrow', contentEditable: true },
        headline: { type: 'text', label: 'Headline', contentEditable: true },
        body: { type: 'textarea', label: 'Body', contentEditable: true },
        imageUrl: { type: 'text', label: 'Image URL' },
        imageAlt: { type: 'text', label: 'Image alt text' },
        ctaLabel: { type: 'text', label: 'CTA label', contentEditable: true },
        ctaUrl: { type: 'text', label: 'CTA URL' },
        alignment: { type: 'radio', label: 'Alignment', options: alignmentOptions },
      },
      defaultProps: {
        eyebrow: '',
        headline: 'Event headline',
        body: '',
        imageUrl: '',
        imageAlt: '',
        ctaLabel: '',
        ctaUrl: '',
        alignment: 'left',
      },
      render: (props) => <HeroBlock {...props} />,
    },
    RichText: {
      label: 'Rich text',
      fields: {
        body: {
          type: 'richtext',
          label: 'Body',
          contentEditable: true,
          initialHeight: 280,
          options: {
            heading: { levels: [2, 3] },
          },
        },
      },
      defaultProps: {
        body: '<p>Add event story, highlights, or accessibility notes.</p>',
      },
      render: (props) => <RichTextBlock {...props} />,
    },
    Media: {
      label: 'Image / media',
      fields: {
        imageUrl: { type: 'text', label: 'Image URL' },
        imageAlt: { type: 'text', label: 'Image alt text' },
        caption: { type: 'text', label: 'Caption', contentEditable: true },
        aspectRatio: { type: 'select', label: 'Aspect ratio', options: aspectRatioOptions },
      },
      defaultProps: {
        imageUrl: '',
        imageAlt: '',
        caption: '',
        aspectRatio: 'auto',
      },
      render: (props) => <MediaBlock {...props} />,
    },
    EventDetails: {
      label: 'Event details',
      fields: {
        title: { type: 'text', label: 'Title', contentEditable: true },
        items: {
          type: 'array',
          label: 'Details',
          min: 1,
          arrayFields: {
            label: { type: 'text', label: 'Label' },
            value: { type: 'text', label: 'Value' },
          },
          defaultItemProps: { label: 'Detail', value: '' },
          getItemSummary: (item) => item.label || 'Detail',
        },
      },
      defaultProps: {
        title: 'Event details',
        items: [{ label: 'Date', value: 'Add date' }],
      },
      render: (props) => <EventDetailsBlock {...props} />,
    },
    Schedule: {
      label: 'Schedule',
      fields: {
        title: { type: 'text', label: 'Title', contentEditable: true },
        items: {
          type: 'array',
          label: 'Schedule items',
          min: 1,
          arrayFields: {
            title: { type: 'text', label: 'Title' },
            startsAt: { type: 'text', label: 'Starts at' },
            endsAt: { type: 'text', label: 'Ends at' },
            location: { type: 'text', label: 'Location' },
            description: { type: 'textarea', label: 'Description' },
          },
          defaultItemProps: { title: 'Session', startsAt: '', endsAt: '', location: '', description: '' },
          getItemSummary: (item) => item.title || 'Schedule item',
        },
      },
      defaultProps: {
        title: 'Schedule',
        items: [{ title: 'Event starts', startsAt: '' }],
      },
      render: (props) => <ScheduleBlock {...props} />,
    },
    Venue: {
      label: 'Venue',
      fields: {
        title: { type: 'text', label: 'Title', contentEditable: true },
        venueName: { type: 'text', label: 'Venue name', contentEditable: true },
        address: { type: 'textarea', label: 'Address', contentEditable: true },
        mapUrl: { type: 'text', label: 'Map URL' },
      },
      defaultProps: {
        title: 'Venue',
        venueName: 'Venue to be announced',
        address: '',
        mapUrl: '',
      },
      render: (props) => <VenueBlock {...props} />,
    },
    FAQ: {
      label: 'FAQ',
      fields: {
        title: { type: 'text', label: 'Title', contentEditable: true },
        items: {
          type: 'array',
          label: 'Questions',
          min: 1,
          arrayFields: {
            question: { type: 'text', label: 'Question' },
            answer: { type: 'textarea', label: 'Answer' },
          },
          defaultItemProps: { question: 'Question', answer: '' },
          getItemSummary: (item) => item.question || 'Question',
        },
      },
      defaultProps: {
        title: 'FAQ',
        items: [{ question: 'What should guests know?', answer: 'Add an answer.' }],
      },
      render: ({ puck, ...props }) => <FAQBlock {...props} editorPreview={puck.isEditing} />,
    },
    Sponsors: {
      label: 'Sponsors',
      fields: {
        title: { type: 'text', label: 'Title', contentEditable: true },
        items: {
          type: 'array',
          label: 'Sponsors',
          arrayFields: {
            name: { type: 'text', label: 'Name' },
            url: { type: 'text', label: 'URL' },
            imageUrl: { type: 'text', label: 'Logo URL' },
            imageAlt: { type: 'text', label: 'Logo alt text' },
          },
          defaultItemProps: { name: 'Sponsor', url: '', imageUrl: '', imageAlt: '' },
          getItemSummary: (item) => item.name || 'Sponsor',
        },
      },
      defaultProps: {
        title: 'Sponsors',
        items: [],
      },
      render: (props) => <SponsorsBlock {...props} />,
    },
    Speakers: {
      label: 'Speakers',
      fields: {
        title: { type: 'text', label: 'Title', contentEditable: true },
        items: {
          type: 'array',
          label: 'Speakers',
          arrayFields: {
            name: { type: 'text', label: 'Name' },
            role: { type: 'text', label: 'Role' },
            bio: { type: 'textarea', label: 'Bio' },
            imageUrl: { type: 'text', label: 'Image URL' },
            imageAlt: { type: 'text', label: 'Image alt text' },
            url: { type: 'text', label: 'URL' },
          },
          defaultItemProps: { name: 'Speaker', role: '', bio: '', imageUrl: '', imageAlt: '', url: '' },
          getItemSummary: (item) => item.name || 'Speaker',
        },
      },
      defaultProps: {
        title: 'Speakers',
        items: [],
      },
      render: (props) => <SpeakersBlock {...props} />,
    },
    Button: {
      label: 'Button',
      fields: {
        label: { type: 'text', label: 'Label', contentEditable: true },
        url: { type: 'text', label: 'URL' },
        style: { type: 'select', label: 'Style', options: buttonStyleOptions },
        alignment: { type: 'radio', label: 'Alignment', options: alignmentOptions },
      },
      defaultProps: {
        label: 'Learn more',
        url: '#',
        style: 'primary',
        alignment: 'left',
      },
      render: (props) => <ButtonBlock {...props} />,
    },
    Divider: {
      label: 'Divider',
      fields: {
        spacing: { type: 'select', label: 'Spacing', options: dividerSpacingOptions },
      },
      defaultProps: {
        spacing: 'normal',
      },
      render: (props) => <DividerBlock {...props} />,
    },
    SocialLinks: {
      label: 'Social links',
      fields: {
        title: { type: 'text', label: 'Title', contentEditable: true },
        links: {
          type: 'array',
          label: 'Links',
          min: 1,
          arrayFields: {
            label: { type: 'text', label: 'Label' },
            url: { type: 'text', label: 'URL' },
          },
          defaultItemProps: { label: 'Link', url: '' },
          getItemSummary: (item) => item.label || 'Link',
        },
      },
      defaultProps: {
        title: 'Follow us',
        links: [{ label: 'Instagram', url: '' }],
      },
      render: (props) => <SocialLinksBlock {...props} />,
    },
    CustomEmbed: {
      label: 'Custom embed',
      fields: {
        html: { type: 'textarea', label: 'Embed HTML' },
        allowUnsafeEmbed: {
          type: 'radio',
          label: 'Embed approval',
          options: [
            { label: 'Disabled', value: false },
            { label: 'Approved', value: true },
          ],
        },
      },
      defaultProps: {
        html: '',
        allowUnsafeEmbed: false,
      },
      render: (props) => <CustomEmbedBlock {...props} />,
    },
  },
};

export function EventPageRender({
  document,
  data,
  className,
  brandVariables,
  metadata,
  validate = true,
  validationOptions,
  fallback = null,
}: EventPageRenderProps) {
  const renderData = resolveRenderData(document, data);
  if (!renderData) return <>{fallback}</>;

  if (validate) {
    const result = validateEventPageDocument(
      document ??
        ({
          schemaVersion: 2,
          editor: { provider: PUCK_EVENT_PAGE_PROVIDER, data: renderData },
          settings: { locale: 'en', discovery: { summary: 'Event page', tags: [] } },
        } satisfies EventPageDocument),
      validationOptions,
    );
    if (!result.valid) return <>{fallback}</>;
  }

  return (
    <div
      className={joinClassNames(EVENT_PAGE_PUCK_STYLES_CLASS, className)}
      data-provider={PUCK_EVENT_PAGE_PROVIDER}
      style={eventPageBrandVariablesToCssProperties(brandVariables)}
    >
      <Render
        config={eventPagePuckConfig}
        data={renderData as EventPagePuckCoreData}
        metadata={metadata}
      />
    </div>
  );
}

export const EventPagePuckRender = EventPageRender;

export function EventPageRoot({
  children,
  title,
  description,
  backgroundColor,
  foregroundColor,
  accentColor,
  accentForegroundColor,
  fontFamily,
  headingFontFamily,
  radius,
}: EventPageRootRenderProps) {
  return (
    <div
      className="tixkit-event-page"
      data-page-title={title}
      data-page-description={description}
      data-schema-provider={PUCK_EVENT_PAGE_PROVIDER}
      style={rootStyle({
        backgroundColor,
        foregroundColor,
        accentColor,
        accentForegroundColor,
        fontFamily,
        headingFontFamily,
        radius,
      })}
    >
      {children}
    </div>
  );
}

export function HeroBlock({
  id,
  eyebrow,
  headline,
  body,
  imageUrl,
  imageAlt,
  ctaLabel,
  ctaUrl,
  alignment = 'left',
}: WithBlockId<EventPageHeroProps>) {
  return (
    <section className={`tk-ep-hero tk-ep-align-${alignment}`} data-block-id={id}>
      <div className="tk-ep-hero__copy">
        {eyebrow ? <p className="tk-ep-eyebrow">{eyebrow}</p> : null}
        <h1>{headline}</h1>
        {body ? <p className="tk-ep-hero__body">{body}</p> : null}
        {ctaLabel && ctaUrl ? (
          <a className="tk-ep-button" href={ctaUrl}>
            {ctaLabel}
          </a>
        ) : null}
      </div>
      {imageUrl ? (
        <img className="tk-ep-hero__image" src={imageUrl} alt={imageAlt ?? ''} loading="lazy" />
      ) : null}
    </section>
  );
}

export function RichTextBlock({ id, body }: WithBlockId<EventPageRichTextProps>) {
  return (
    <section
      className="tk-ep-rich-text"
      data-block-id={id}
      dangerouslySetInnerHTML={{ __html: sanitizeEventPageHtml(body) }}
    />
  );
}

export function MediaBlock({
  id,
  imageUrl,
  imageAlt,
  caption,
  aspectRatio = 'auto',
}: WithBlockId<EventPageMediaProps>) {
  if (!imageUrl) return null;
  return (
    <figure className={`tk-ep-media tk-ep-media--${aspectRatio.replace(':', '-')}`} data-block-id={id}>
      <img src={imageUrl} alt={imageAlt} loading="lazy" />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

export function EventDetailsBlock({ id, title, items }: WithBlockId<EventPageDetailsProps>) {
  return (
    <section className="tk-ep-details" data-block-id={id}>
      <h2>{title}</h2>
      <dl>
        {items.map((item) => (
          <div key={`${item.label}:${item.value}`}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ScheduleBlock({ id, title, items }: WithBlockId<EventPageScheduleProps>) {
  return (
    <section className="tk-ep-schedule" data-block-id={id}>
      <h2>{title}</h2>
      <ol>
        {items.map((item, index) => (
          <li key={`${item.title}:${item.startsAt}:${index}`}>
            <div>
              <strong>{item.title}</strong>
              <span>{formatScheduleRange(item.startsAt, item.endsAt)}</span>
            </div>
            {item.location ? <p>{item.location}</p> : null}
            {item.description ? <p>{item.description}</p> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function VenueBlock({ id, title, venueName, address, mapUrl }: WithBlockId<EventPageVenueProps>) {
  return (
    <section className="tk-ep-venue" data-block-id={id}>
      <h2>{title}</h2>
      <p className="tk-ep-venue__name">{venueName}</p>
      {address ? <p>{address}</p> : null}
      {mapUrl ? (
        <a className="tk-ep-link" href={mapUrl}>
          View map
        </a>
      ) : null}
    </section>
  );
}

export function FAQBlock({
  id,
  title,
  items,
  editorPreview = false,
}: WithBlockId<EventPageFaqProps> & { editorPreview?: boolean }) {
  return (
    <section className="tk-ep-faq" data-block-id={id}>
      <h2>{title}</h2>
      {items.map((item) => (
        editorPreview ? (
          <div className="tk-ep-faq__item" key={item.question}>
            <h3>{item.question}</h3>
            <p>{item.answer}</p>
          </div>
        ) : (
          <details key={item.question}>
            <summary>{item.question}</summary>
            <p>{item.answer}</p>
          </details>
        )
      ))}
    </section>
  );
}

export function SponsorsBlock({ id, title, items }: WithBlockId<EventPageSponsorsProps>) {
  return (
    <section className="tk-ep-sponsors" data-block-id={id}>
      <h2>{title}</h2>
      <ul className="tk-ep-logo-list">
        {items.map((item) => (
          <li key={item.name}>
            {item.imageUrl ? <img src={item.imageUrl} alt={item.imageAlt ?? item.name} loading="lazy" /> : null}
            {item.url ? <a href={item.url}>{item.name}</a> : <span>{item.name}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SpeakersBlock({ id, title, items }: WithBlockId<EventPageSpeakersProps>) {
  return (
    <section className="tk-ep-speakers" data-block-id={id}>
      <h2>{title}</h2>
      <ul className="tk-ep-person-list">
        {items.map((item) => (
          <li key={item.name}>
            {item.imageUrl ? <img src={item.imageUrl} alt={item.imageAlt ?? item.name} loading="lazy" /> : null}
            <div>
              <strong>{item.url ? <a href={item.url}>{item.name}</a> : item.name}</strong>
              {item.role ? <span>{item.role}</span> : null}
              {item.bio ? <p>{item.bio}</p> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ButtonBlock({
  id,
  label,
  url,
  style = 'primary',
  alignment = 'left',
}: WithBlockId<EventPageButtonProps>) {
  return (
    <section className={`tk-ep-button-row tk-ep-align-${alignment}`} data-block-id={id}>
      <a className={`tk-ep-button tk-ep-button--${style}`} href={url}>
        {label}
      </a>
    </section>
  );
}

export function DividerBlock({ id, spacing = 'normal' }: WithBlockId<EventPageDividerProps>) {
  return <hr className={`tk-ep-divider tk-ep-divider--${spacing}`} data-block-id={id} />;
}

export function SocialLinksBlock({ id, title, links }: WithBlockId<EventPageSocialLinksProps>) {
  return (
    <section className="tk-ep-social-links" data-block-id={id}>
      {title ? <h2>{title}</h2> : null}
      <ul>
        {links.map((link) => (
          <li key={`${link.label}:${link.url}`}>
            <a href={link.url}>{link.label}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CustomEmbedBlock({ id, html }: WithBlockId<EventPageCustomEmbedProps>) {
  if (!html) return null;
  return (
    <section
      className="tk-ep-embed"
      data-block-id={id}
      dangerouslySetInnerHTML={{ __html: sanitizeEventPageHtml(html) }}
    />
  );
}

export function isEventPagePuckComponentType(value: string): value is EventPagePuckComponentType {
  return EVENT_PAGE_PUCK_COMPONENT_TYPES.includes(value as EventPagePuckComponentType);
}

export function resolveRenderData(
  document: EventPageRenderProps['document'],
  data: EventPageRenderProps['data'],
): EventPagePuckData | undefined {
  if (data && isPuckData(data)) return data;
  const normalized = normalizeEventPageDocument(document);
  return normalized?.editor.data;
}

export function createEventPageRenderStyle(
  brandVariables?: EventPageBrandVariables,
): CSSProperties & Record<string, string> {
  return eventPageBrandVariablesToCssProperties(brandVariables) as CSSProperties & Record<string, string>;
}

function rootStyle(props: EventPageRootProps): CSSProperties & Record<string, string> {
  const style: CSSProperties & Record<string, string> = {};
  if (props.backgroundColor) style['--tk-ep-bg'] = props.backgroundColor;
  if (props.foregroundColor) style['--tk-ep-fg'] = props.foregroundColor;
  if (props.accentColor) style['--tk-ep-accent'] = props.accentColor;
  if (props.accentForegroundColor) style['--tk-ep-accent-fg'] = props.accentForegroundColor;
  if (props.fontFamily) style['--tk-ep-font-body'] = props.fontFamily;
  if (props.headingFontFamily) style['--tk-ep-font-heading'] = props.headingFontFamily;
  if (props.radius) style['--tk-ep-radius'] = props.radius;
  return style;
}

export function isEventPagePuckData(value: unknown): value is EventPagePuckData {
  return (
    typeof value === 'object' &&
    value !== null &&
    'root' in value &&
    'content' in value &&
    typeof (value as { root?: unknown }).root === 'object' &&
    (value as { root?: unknown }).root !== null &&
    'props' in ((value as { root: Record<string, unknown> }).root) &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function isPuckData(value: unknown): value is EventPagePuckData {
  return isEventPagePuckData(value);
}

function joinClassNames(...classNames: Array<string | undefined>): string {
  return classNames.filter(Boolean).join(' ');
}

function formatScheduleRange(startsAt: string, endsAt?: string): string {
  if (!startsAt && !endsAt) return '';
  if (!endsAt) return startsAt;
  return `${startsAt} - ${endsAt}`;
}
