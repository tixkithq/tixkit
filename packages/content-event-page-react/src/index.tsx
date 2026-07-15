import {
  Render,
  registerOverlayPortal,
  type Config,
  type Data,
  type IframeConfig,
  type Metadata,
} from '@puckeditor/core';
import {
  EVENT_PAGE_PUCK_COMPONENT_TYPES,
  PUCK_EVENT_PAGE_PROVIDER,
  eventPageMediaReferenceRole,
  eventPageBrandVariablesToCssProperties,
  formatTimezoneLabel,
  isSafeEventPageImageSource,
  normalizeEventPageDocument,
  sanitizeEventPageEmbedHtml,
  sanitizeEventPageHtml,
  validateEventPageDocument,
  type EventPageBrandFooterProps,
  type EventPageBrandVariables,
  type EventPageButtonProps,
  type EventPageCheckoutCtaProps,
  type EventPageCustomEmbedProps,
  type EventPageDetailsProps,
  type EventPageDividerProps,
  type EventPageDocument,
  type EventPageEventDescriptionProps,
  type EventPageEventHeaderProps,
  type EventPageFaqProps,
  type EventPageMediaProps,
  type EventPageMediaRole,
  type EventPagePuckComponentType,
  type EventPageProductAddOnsProps,
  type EventPagePuckData,
  type EventPageResaleTicketsProps,
  type EventPageRichTextProps,
  type EventPageRootProps,
  type EventPageScheduleProps,
  type EventPageSocialLinksProps,
  type EventPageSpeakersProps,
  type EventPageSponsorsProps,
  type EventPageTicketsProps,
  type EventPageVenueProps,
  type EventPageValidationOptions,
} from '@tixkit/content-event-page';
import * as React from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  ImageIcon,
  MapPinIcon,
  TicketIcon,
} from 'lucide-react';
import {
  BrandFooterBlock,
  CheckoutCtaBlock,
  EventPageRuntimeProvider,
  ProductAddOnsBlock,
  ResaleTicketsBlock,
  TicketsBlock,
  type EventPageRuntime,
  useEventPageRuntime,
} from './public-surface.js';

export type EventPagePuckComponentProps = {
  EventHeader: EventPageEventHeaderProps;
  EventDescription: EventPageEventDescriptionProps;
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
  Tickets: EventPageTicketsProps;
  ProductAddOns: EventPageProductAddOnsProps;
  ResaleTickets: EventPageResaleTicketsProps;
  CheckoutCta: EventPageCheckoutCtaProps;
  BrandFooter: EventPageBrandFooterProps;
};

export type EventPagePuckCategory =
  | 'essentials'
  | 'story'
  | 'information'
  | 'peopleAndPartners'
  | 'actions'
  | 'commerce';
type EventPageEditorUiProps = {
  showAdvanced?: boolean;
} & {
  [K in `_${string}`]?: unknown;
};
type WithEditorUiProps<T> = T & EventPageEditorUiProps;
type EventPagePuckEditorComponentProps = {
  [K in keyof EventPagePuckComponentProps]: WithEditorUiProps<EventPagePuckComponentProps[K]>;
};
type EventPagePuckEditorRootProps = WithEditorUiProps<EventPageRootProps>;
export type EventPagePuckConfig = Config<
  EventPagePuckEditorComponentProps,
  EventPagePuckEditorRootProps,
  EventPagePuckCategory
>;
export type EventPagePuckCoreData = Data<EventPagePuckComponentProps, EventPageRootProps>;
export type EventPagePuckUploadImage = (file: File) => Promise<{ url: string }>;
export type EventPageMediaChoice = {
  role: EventPageMediaRole;
  label: string;
  value: string;
  previewUrl?: string;
  altText: string;
};
export type EventPagePuckConfigOptions = {
  allowUnsafeEmbeds?: boolean;
  onUploadImage?: EventPagePuckUploadImage;
  hasCommerceItems?: boolean;
  hasProductItems?: boolean;
  eventMediaChoices?: readonly EventPageMediaChoice[];
};

type WithBlockId<T> = T & { id?: string };
type EventPageRootRenderProps = EventPageRootProps & { children?: ReactNode };
type CustomFieldRenderProps<Value = string> = {
  field: { label?: string };
  id: string;
  name: string;
  value: Value | undefined;
  onChange: (value: Value) => void;
  readOnly?: boolean;
};
type QuickFieldValue<Value extends string = string> = {
  label: string;
  value: Value;
};
// Custom Puck field helpers are intentionally loose; Puck's Field generics are stricter than needed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyField = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFields = Record<string, any>;
type LengthUnit = 'px' | 'rem' | 'em' | '%' | 'vh' | 'vw' | 'ch';
type OverlaySlotRender = (props?: {
  className?: string;
  style?: CSSProperties;
  minEmptyHeight?: CSSProperties['minHeight'] | number;
}) => ReactNode;
type InlineTextField = {
  type: 'text';
  label: string;
  contentEditable: true;
  visible: false;
};
type InlineTextareaField = {
  type: 'textarea';
  label: string;
  contentEditable: true;
  visible: false;
};
type InlineRichTextField = {
  type: 'richtext';
  label: string;
  contentEditable: true;
  visible: false;
};

export type EventPageRenderProps = {
  document?: EventPageDocument | unknown;
  data?: EventPagePuckData | unknown;
  className?: string;
  brandVariables?: EventPageBrandVariables;
  metadata?: Metadata;
  /** Live tickets/resale/checkout/footer data for chrome blocks. */
  runtime?: EventPageRuntime;
  validate?: boolean;
  validationOptions?: EventPageValidationOptions;
  fallback?: ReactNode;
};

export const EVENT_PAGE_PUCK_STYLES_CLASS = 'tixkit-event-page-puck-scope';

export const eventPagePuckIframeConfig: IframeConfig = {
  enabled: true,
  waitForStyles: true,
  syncHostStyles: true,
};

function resolveEventPageImage(
  imageUrl: unknown,
  imageAlt: unknown,
  runtime: EventPageRuntime,
): { url: string; altText: string } | undefined {
  if (typeof imageUrl !== 'string') return undefined;
  const source = imageUrl.trim();
  if (!source) return undefined;
  const role = eventPageMediaReferenceRole(source);
  if (role) {
    const media = runtime.eventMedia?.[role];
    const runtimeUrl = media?.url.trim();
    const safeRuntimeUrl =
      typeof runtimeUrl === 'string' &&
      ((runtime.interactive === false && runtimeUrl.startsWith('blob:')) ||
        isSafeEventPageImageSource(runtimeUrl));
    return media && safeRuntimeUrl
      ? {
          url: runtimeUrl,
          altText:
            typeof imageAlt === 'string' && imageAlt.trim() ? imageAlt.trim() : media.altText,
        }
      : undefined;
  }
  if (!isSafeEventPageImageSource(source)) return undefined;
  return {
    url: source,
    altText: typeof imageAlt === 'string' ? imageAlt.trim() : '',
  };
}

const alignmentOptions = [
  { label: 'Left', value: 'left' },
  { label: 'Center', value: 'center' },
  { label: 'Right', value: 'right' },
] as const;

const buttonStyleOptions = [
  { label: 'Primary', value: 'primary' },
  { label: 'Secondary', value: 'secondary' },
  { label: 'Link', value: 'link' },
] as const;

const buttonSizeOptions = [
  { label: 'Medium', value: 'medium' },
  { label: 'Small', value: 'small' },
  { label: 'Large', value: 'large' },
] as const;

const buttonWidthOptions = [
  { label: 'Auto', value: 'auto' },
  { label: 'Full width', value: 'full' },
] as const;

const buttonRadiusOptions = [
  { label: 'Soft', value: 'soft' },
  { label: 'Tight', value: 'tight' },
  { label: 'Square', value: 'square' },
  { label: 'Pill', value: 'pill' },
] as const;

const buttonTextStyleOptions = [
  { label: 'Normal', value: 'normal' },
  { label: 'Bold', value: 'bold' },
  { label: 'Uppercase', value: 'uppercase' },
] as const;

const aspectRatioOptions = [
  { label: 'Auto', value: 'auto' },
  { label: '16:9', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '1:1', value: '1:1' },
] as const;

const mediaWidthOptions = [
  { label: 'Normal', value: 'normal' },
  { label: 'Wide', value: 'wide' },
] as const;

const heroImageLayoutOptions = [
  { label: 'Inline image', value: 'inline' },
  { label: 'Background image', value: 'background' },
] as const;

const heroImageFitOptions = [
  { label: 'Cover', value: 'cover' },
  { label: 'Contain', value: 'contain' },
] as const;

const heroImagePositionOptions = [
  { label: 'Center', value: 'center' },
  { label: 'Top', value: 'top' },
  { label: 'Bottom', value: 'bottom' },
  { label: 'Left', value: 'left' },
  { label: 'Right', value: 'right' },
] as const;

const overlayPositionOptions = [
  { label: 'Center', value: 'center' },
  { label: 'Top', value: 'top' },
  { label: 'Bottom', value: 'bottom' },
] as const;

const heroLogoPositionOptions = [
  { label: 'Top left', value: 'top-left' },
  { label: 'Top center', value: 'top-center' },
  { label: 'Top right', value: 'top-right' },
  { label: 'Bottom left', value: 'bottom-left' },
  { label: 'Bottom center', value: 'bottom-center' },
  { label: 'Bottom right', value: 'bottom-right' },
] as const;

const radiusPresetOptions = [
  { label: 'Soft', value: 'soft' },
  { label: 'Tight', value: 'tight' },
  { label: 'None', value: 'none' },
  { label: 'Round', value: 'round' },
] as const;

const textSizeOptions = [
  { label: 'Normal', value: 'normal' },
  { label: 'Small', value: 'small' },
  { label: 'Large', value: 'large' },
] as const;

const commercePreviewStateOptions = [
  { label: 'Live data', value: 'live' },
  { label: 'Empty state', value: 'empty' },
  { label: 'Example items', value: 'populated' },
] as const;

const dividerSpacingOptions = [
  { label: 'Normal', value: 'normal' },
  { label: 'Compact', value: 'compact' },
  { label: 'Loose', value: 'loose' },
] as const;

const sectionStyleOptions = [
  { label: 'Plain', value: 'plain' },
  { label: 'Outlined', value: 'outlined' },
  { label: 'Filled', value: 'filled' },
] as const;

const pageColorSwatches = [
  '#ffffff',
  '#f8fafc',
  '#111827',
  '#0f172a',
  '#2563eb',
  '#7c3aed',
  '#dc2626',
  '#f59e0b',
  '#16a34a',
] as const;

const fontChoices = [
  { label: 'Inter', value: 'Inter, system-ui, sans-serif' },
  {
    label: 'System sans',
    value: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  { label: 'Editorial serif', value: 'Georgia, "Times New Roman", serif' },
  {
    label: 'Mono',
    value: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  },
] as const;

const radiusChoices = [
  { label: 'Square', value: '0px' },
  { label: 'Tight', value: '8px' },
  { label: 'Soft', value: '14px' },
  { label: 'Round', value: '24px' },
] as const;

const commonLinkQuickValues: QuickFieldValue[] = [
  { label: 'Top of page', value: '#' },
  { label: 'Email', value: 'mailto:' },
  { label: 'Phone', value: 'tel:' },
];

function inlineTextField(label: string): InlineTextField {
  return { type: 'text', label, contentEditable: true, visible: false };
}

function inlineTextareaField(label: string): InlineTextareaField {
  return { type: 'textarea', label, contentEditable: true, visible: false };
}

function inlineRichTextField(label: string): InlineRichTextField {
  return { type: 'richtext', label, contentEditable: true, visible: false };
}

const lengthUnits: LengthUnit[] = ['px', 'rem', 'em', '%', 'vh', 'vw', 'ch'];

function normalizeFieldValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function FieldControl({
  field,
  help,
  htmlFor,
  children,
  density = 'default',
  icon,
}: {
  field: { label?: string };
  help?: string;
  htmlFor?: string;
  children: ReactNode;
  density?: 'default' | 'compact';
  icon?: ReactNode;
}) {
  return (
    <div
      className={density === 'compact' ? 'tk-ep-field tk-ep-field--compact' : 'tk-ep-field'}
      data-field-control
    >
      {field.label ? (
        <label className="tk-ep-field__label" htmlFor={htmlFor}>
          {icon ? (
            <span className="tk-ep-field__label-icon" aria-hidden>
              {icon}
            </span>
          ) : null}
          {field.label}
        </label>
      ) : null}
      {help ? <p className="tk-ep-field__help">{help}</p> : null}
      <div className="tk-ep-field__control">{children}</div>
    </div>
  );
}

function FieldIcon({ name }: { name: string }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'image':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <circle cx="9" cy="10" r="1.5" />
          <path d="m21 15-4.5-4.5L9 18" />
        </svg>
      );
    case 'layout':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 10h18M10 10v10" />
        </svg>
      );
    case 'cta':
      return (
        <svg {...common}>
          <rect x="3" y="8" width="18" height="8" rx="4" />
          <path d="M10 12h4" />
        </svg>
      );
    case 'type':
      return (
        <svg {...common}>
          <path d="M4 7V5h16v2M9 19h6M12 5v14" />
        </svg>
      );
    case 'panel':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M8 9h8M8 13h5" />
        </svg>
      );
    case 'tune':
      return (
        <svg {...common}>
          <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M8 14v6" />
        </svg>
      );
    case 'page':
      return (
        <svg {...common}>
          <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
          <path d="M14 3v5h5" />
        </svg>
      );
    case 'color':
      return (
        <svg {...common}>
          <path d="M12 3a9 9 0 1 0 0 18 3 3 0 0 0 0-6h-1a2 2 0 1 1 0-4h4" />
          <circle cx="8" cy="10" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'logo':
      return (
        <svg {...common}>
          <rect x="3" y="7" width="18" height="10" rx="2" />
          <path d="M8 12h.01M12 12h.01M16 12h.01" />
        </svg>
      );
    default:
      return null;
  }
}

function FieldSectionControl({
  defaultExpanded,
  description,
  icon,
  title,
}: {
  defaultExpanded: boolean;
  description?: string;
  icon?: string;
  title: string;
}) {
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  return (
    <div
      className="tk-ep-field-section"
      data-field-section={title}
      data-section-expanded={expanded ? 'true' : 'false'}
    >
      <button
        aria-expanded={expanded}
        className="tk-ep-field-section__trigger"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <span className="tk-ep-field-section__title">
          {icon ? (
            <span className="tk-ep-field-section__icon" aria-hidden>
              <FieldIcon name={icon} />
            </span>
          ) : null}
          {title}
        </span>
        <ChevronDownIcon aria-hidden="true" className="tk-ep-field-section__chevron" />
      </button>
      {description ? <p className="tk-ep-field-section__desc">{description}</p> : null}
    </div>
  );
}

function sectionField(
  title: string,
  description?: string,
  icon?: string,
  defaultExpanded = false,
): AnyField {
  return {
    type: 'custom' as const,
    label: title,
    render: () => (
      <FieldSectionControl
        defaultExpanded={defaultExpanded}
        description={description}
        icon={icon}
        title={title}
      />
    ),
  };
}

function advancedToggleField(label = 'Advanced styling'): AnyField {
  return {
    type: 'custom' as const,
    label,
    visible: false,
    render: () => null,
  };
}

function toggleField(
  label: string,
  help = '',
  options: { defaultEnabled?: boolean } = {},
): AnyField {
  const defaultEnabled = options.defaultEnabled ?? false;
  return {
    type: 'custom' as const,
    label,
    render: ({ field, value, onChange, readOnly }: CustomFieldRenderProps<boolean>) => {
      // Match render semantics: missing values use the field default (e.g. CTA on).
      const enabled = value === undefined || value === null ? defaultEnabled : Boolean(value);
      return (
        <div className="tk-ep-field tk-ep-field--toggle" data-field-control>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            disabled={readOnly}
            className={enabled ? 'tk-ep-field-toggle tk-ep-field-toggle--on' : 'tk-ep-field-toggle'}
            onClick={() => onChange(!enabled)}
          >
            <span className="tk-ep-field-toggle__copy">
              <span className="tk-ep-field-toggle__label">{field.label ?? label}</span>
              {help ? <span className="tk-ep-field-toggle__help">{help}</span> : null}
            </span>
            <span className="tk-ep-field-toggle__track" aria-hidden>
              <span className="tk-ep-field-toggle__thumb" />
            </span>
          </button>
        </div>
      );
    },
  };
}

function segmentField<Value extends string>(
  label: string,
  options: readonly QuickFieldValue<Value>[],
  help = '',
): AnyField {
  return choiceField(label, help, options as readonly QuickFieldValue[]);
}

function AlignGlyph({ value }: { value: 'left' | 'center' | 'right' }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    'aria-hidden': true,
  };
  if (value === 'left') {
    return (
      <svg {...common}>
        <path d="M2 3.5h12M2 8h8M2 12.5h10" />
      </svg>
    );
  }
  if (value === 'right') {
    return (
      <svg {...common}>
        <path d="M2 3.5h12M6 8h8M4 12.5h10" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M2 3.5h12M4 8h8M3 12.5h10" />
    </svg>
  );
}

function StackGlyph({ value }: { value: 'top' | 'center' | 'bottom' }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'currentColor',
    'aria-hidden': true,
  };
  if (value === 'top') {
    return (
      <svg {...common}>
        <rect x="3" y="2.5" width="10" height="2" rx="1" />
        <rect x="4.5" y="6.5" width="7" height="1.5" rx="0.75" opacity="0.45" />
        <rect x="4.5" y="9.5" width="7" height="1.5" rx="0.75" opacity="0.3" />
      </svg>
    );
  }
  if (value === 'bottom') {
    return (
      <svg {...common}>
        <rect x="4.5" y="5" width="7" height="1.5" rx="0.75" opacity="0.3" />
        <rect x="4.5" y="8" width="7" height="1.5" rx="0.75" opacity="0.45" />
        <rect x="3" y="11.5" width="10" height="2" rx="1" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="4.5" y="3.5" width="7" height="1.5" rx="0.75" opacity="0.3" />
      <rect x="3" y="7" width="10" height="2" rx="1" />
      <rect x="4.5" y="11" width="7" height="1.5" rx="0.75" opacity="0.3" />
    </svg>
  );
}

function alignmentIconField(
  label: string,
  help = '',
  options: readonly QuickFieldValue<'left' | 'center' | 'right'>[] = alignmentOptions,
): AnyField {
  return {
    type: 'custom' as const,
    label,
    render: ({ field, value, onChange, readOnly }: CustomFieldRenderProps<string>) => {
      const current = normalizeFieldValue(value) || 'left';
      return (
        <FieldControl field={field} help={help || undefined}>
          <fieldset className="tk-ep-field__icon-group" aria-label={field.label ?? label}>
            {options.map((option) => {
              const selected = current === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={readOnly}
                  aria-label={option.label}
                  aria-pressed={selected}
                  title={option.label}
                  className={
                    selected
                      ? 'tk-ep-field__icon-btn tk-ep-field__icon-btn--active'
                      : 'tk-ep-field__icon-btn'
                  }
                  onClick={() => onChange(option.value)}
                >
                  <AlignGlyph value={option.value} />
                </button>
              );
            })}
          </fieldset>
        </FieldControl>
      );
    },
  };
}

function stackIconField(
  label: string,
  help = '',
  options: readonly QuickFieldValue<'top' | 'center' | 'bottom'>[] = overlayPositionOptions,
): AnyField {
  return {
    type: 'custom' as const,
    label,
    render: ({ field, value, onChange, readOnly }: CustomFieldRenderProps<string>) => {
      const current = normalizeFieldValue(value) || 'center';
      return (
        <FieldControl field={field} help={help || undefined}>
          <fieldset className="tk-ep-field__icon-group" aria-label={field.label ?? label}>
            {options.map((option) => {
              const selected = current === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={readOnly}
                  aria-label={option.label}
                  aria-pressed={selected}
                  title={option.label}
                  className={
                    selected
                      ? 'tk-ep-field__icon-btn tk-ep-field__icon-btn--active'
                      : 'tk-ep-field__icon-btn'
                  }
                  onClick={() => onChange(option.value)}
                >
                  <StackGlyph value={option.value} />
                </button>
              );
            })}
          </fieldset>
        </FieldControl>
      );
    },
  };
}

function placementGridField(
  label: string,
  options: readonly { label: string; value: string }[],
  help = '',
): AnyField {
  return {
    type: 'custom' as const,
    label,
    render: ({ field, value, onChange, readOnly }: CustomFieldRenderProps<string>) => {
      const current = normalizeFieldValue(value) || options[0]?.value || '';
      return (
        <FieldControl field={field} help={help || undefined}>
          <fieldset className="tk-ep-field__placement" aria-label={field.label ?? label}>
            <div className="tk-ep-field__placement-frame">
              <div className="tk-ep-field__placement-grid">
                {options.map((option) => {
                  const selected = current === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={readOnly}
                      aria-label={option.label}
                      aria-pressed={selected}
                      title={option.label}
                      className={
                        selected
                          ? 'tk-ep-field__placement-cell tk-ep-field__placement-cell--active'
                          : 'tk-ep-field__placement-cell'
                      }
                      onClick={() => onChange(option.value)}
                    >
                      <span className="tk-ep-field__placement-dot" aria-hidden />
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="tk-ep-field__placement-label">
              {options.find((option) => option.value === current)?.label ?? 'Choose a corner'}
            </p>
          </fieldset>
        </FieldControl>
      );
    },
  };
}

function omitFields(fields: AnyFields, keys: readonly string[]): AnyFields {
  const next = { ...fields };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function colorField(label: string, help: string): AnyField {
  return {
    type: 'custom',
    label,
    render: ({ field, id, name, value, onChange, readOnly }: CustomFieldRenderProps<string>) => {
      const stringValue = normalizeFieldValue(value);
      const colorValue = /^#[0-9a-f]{6}$/i.test(stringValue) ? stringValue : '#111111';

      return (
        <FieldControl field={field} help={help} htmlFor={id} density="compact">
          <div className="tk-ep-field__color-row">
            <input
              id={id}
              name={name}
              type="color"
              value={colorValue}
              disabled={readOnly}
              aria-label={field.label}
              className="tk-ep-field__color-swatch-input"
              onChange={(event) => onChange(event.currentTarget.value)}
            />
            <input
              aria-label={`${field.label ?? label} hex value`}
              name={`${name}Hex`}
              type="text"
              value={stringValue}
              disabled={readOnly}
              spellCheck={false}
              placeholder="#111111"
              className="tk-ep-field__input"
              onChange={(event) => onChange(event.currentTarget.value)}
            />
          </div>
          <div className="tk-ep-field__swatches">
            {pageColorSwatches.map((swatch) => {
              const selected = stringValue.toLowerCase() === swatch;
              return (
                <button
                  key={swatch}
                  type="button"
                  disabled={readOnly}
                  aria-label={`Use ${swatch}`}
                  aria-pressed={selected}
                  className={
                    selected
                      ? 'tk-ep-field__swatch tk-ep-field__swatch--active'
                      : 'tk-ep-field__swatch'
                  }
                  style={{ background: swatch }}
                  onClick={() => onChange(swatch)}
                />
              );
            })}
          </div>
        </FieldControl>
      );
    },
  } as const;
}

function choiceField(
  label: string,
  help: string,
  choices: readonly QuickFieldValue[],
  preview?: (value: string) => ReactNode,
): AnyField {
  return {
    type: 'custom',
    label,
    render: ({ field, value, onChange, readOnly }: CustomFieldRenderProps<string>) => {
      const stringValue = normalizeFieldValue(value);

      return (
        <FieldControl field={field} help={help || undefined}>
          {preview ? <div className="tk-ep-field__preview">{preview(stringValue)}</div> : null}
          <fieldset className="tk-ep-field__chips" aria-label={field.label ?? label}>
            {choices.map((choice) => {
              const selected = stringValue === choice.value;
              return (
                <button
                  key={choice.value}
                  type="button"
                  disabled={readOnly}
                  aria-pressed={selected}
                  className={
                    selected ? 'tk-ep-field__chip tk-ep-field__chip--active' : 'tk-ep-field__chip'
                  }
                  onClick={() => onChange(choice.value)}
                >
                  {choice.label}
                </button>
              );
            })}
          </fieldset>
        </FieldControl>
      );
    },
  } as const;
}

function urlField(
  label: string,
  help: string,
  quickValues: QuickFieldValue[] = commonLinkQuickValues,
): AnyField {
  return {
    type: 'custom',
    label,
    render: ({ field, id, name, value, onChange, readOnly }: CustomFieldRenderProps) => (
      <FieldControl field={field} help={help} htmlFor={id}>
        <input
          id={id}
          name={name}
          type="url"
          value={normalizeFieldValue(value)}
          disabled={readOnly}
          spellCheck={false}
          placeholder="https://..."
          className="tk-ep-field__input"
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <div className="tk-ep-field__chips">
          {quickValues.map((quickValue) => (
            <button
              key={`${quickValue.label}:${quickValue.value}`}
              type="button"
              disabled={readOnly}
              className="tk-ep-field__chip"
              onClick={() => onChange(quickValue.value)}
            >
              {quickValue.label}
            </button>
          ))}
        </div>
      </FieldControl>
    ),
  } as const;
}

function parseLengthValue(
  value: unknown,
  fallbackUnit: LengthUnit,
): { amount: string; unit: LengthUnit } {
  const stringValue = normalizeFieldValue(value);
  const match = /^(-?(?:\d+|\d*\.\d+))(px|rem|em|%|vh|vw|ch)$/.exec(stringValue.trim());
  return {
    amount: match?.[1] ?? '',
    unit: (match?.[2] as LengthUnit | undefined) ?? fallbackUnit,
  };
}

function lengthField(label: string, help: string, fallbackUnit: LengthUnit = 'px'): AnyField {
  return {
    type: 'custom',
    label,
    render: ({ field, id, name, value, onChange, readOnly }: CustomFieldRenderProps<string>) => {
      const parsed = parseLengthValue(value, fallbackUnit);
      const commit = (amount: string, unit: LengthUnit) => {
        const normalizedAmount = amount.trim();
        onChange(normalizedAmount ? `${normalizedAmount}${unit}` : '');
      };

      return (
        <FieldControl field={field} help={help} htmlFor={id} density="compact">
          <div className="tk-ep-field__unit-row">
            <input
              id={id}
              name={name}
              type="number"
              step="0.05"
              value={parsed.amount}
              disabled={readOnly}
              placeholder="Auto"
              className="tk-ep-field__input"
              onChange={(event) => commit(event.currentTarget.value, parsed.unit)}
            />
            <select
              id={`${id}-unit`}
              name={`${name}Unit`}
              value={parsed.unit}
              disabled={readOnly}
              aria-label={`${field.label ?? label} unit`}
              className="tk-ep-field__select tk-ep-field__select--unit"
              onChange={(event) => commit(parsed.amount, event.currentTarget.value as LengthUnit)}
            >
              {lengthUnits.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </div>
        </FieldControl>
      );
    },
  } as const;
}

function numberOrLengthField(
  label: string,
  help: string,
  fallbackUnit: LengthUnit = 'px',
): AnyField {
  return {
    type: 'custom',
    label,
    render: ({ field, id, name, value, onChange, readOnly }: CustomFieldRenderProps) => {
      const stringValue = normalizeFieldValue(value);
      const unitless = /^(?:\d+|\d*\.\d+)$/.test(stringValue.trim());
      const parsed = unitless
        ? { amount: stringValue, unit: '' }
        : parseLengthValue(value, fallbackUnit);
      const commit = (amount: string, unit: string) => {
        const normalizedAmount = amount.trim();
        onChange(normalizedAmount ? `${normalizedAmount}${unit}` : '');
      };

      return (
        <FieldControl field={field} help={help} htmlFor={id} density="compact">
          <div className="tk-ep-field__unit-row">
            <input
              id={id}
              name={name}
              type="number"
              step="0.05"
              value={parsed.amount}
              disabled={readOnly}
              placeholder="Auto"
              className="tk-ep-field__input"
              onChange={(event) => commit(event.currentTarget.value, parsed.unit)}
            />
            <select
              id={`${id}-unit`}
              name={`${name}Unit`}
              value={parsed.unit}
              disabled={readOnly}
              aria-label={`${field.label ?? label} unit`}
              className="tk-ep-field__select tk-ep-field__select--unit"
              onChange={(event) => commit(parsed.amount, event.currentTarget.value)}
            >
              <option value="">number</option>
              {lengthUnits.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </div>
        </FieldControl>
      );
    },
  };
}

function opacityField(label: string, help: string): AnyField {
  return {
    type: 'custom',
    label,
    render: ({ field, id, name, value, onChange, readOnly }: CustomFieldRenderProps) => {
      const rawValue = normalizeFieldValue(value);
      const numericValue = rawValue ? Number(rawValue) : 1;
      const normalizedValue = Number.isFinite(numericValue) ? numericValue : 1;
      const commit = (nextValue: string) => onChange(nextValue);

      return (
        <FieldControl field={field} help={help} htmlFor={id} density="compact">
          <div className="tk-ep-field__range-row">
            <input
              id={id}
              name={name}
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={String(normalizedValue)}
              disabled={readOnly}
              className="tk-ep-field__range"
              onChange={(event) => commit(event.currentTarget.value)}
            />
            <input
              aria-label={`${field.label ?? label} value`}
              name={`${name}Number`}
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={String(normalizedValue)}
              disabled={readOnly}
              className="tk-ep-field__input tk-ep-field__input--narrow"
              onChange={(event) => commit(event.currentTarget.value)}
            />
          </div>
        </FieldControl>
      );
    },
  } as const;
}

type ImagePlacementValue = NonNullable<EventPageEventDescriptionProps['imagePlacement']>;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parsePercent(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Number(value.replace('%', '').trim());
  return Number.isFinite(parsed) ? clampNumber(parsed, 0, 100) : fallback;
}

function formatPercent(value: number): string {
  return `${Math.round(clampNumber(value, 0, 100))}%`;
}

function normalizeHeroImagePlacement(value: unknown): Required<ImagePlacementValue> {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const x = parsePercent((record as ImagePlacementValue).x, 50);
  const y = parsePercent((record as ImagePlacementValue).y, 50);
  const parsedScale = Number((record as ImagePlacementValue).scale ?? '1');
  const scale = Number.isFinite(parsedScale) ? clampNumber(parsedScale, 1, 3) : 1;
  return {
    x: formatPercent(x),
    y: formatPercent(y),
    scale: String(Number(scale.toFixed(2))),
  };
}

const FOCAL_POINT_PRESETS = [
  { x: '0%', y: '0%', label: 'Top left' },
  { x: '50%', y: '0%', label: 'Top' },
  { x: '100%', y: '0%', label: 'Top right' },
  { x: '0%', y: '50%', label: 'Left' },
  { x: '50%', y: '50%', label: 'Center' },
  { x: '100%', y: '50%', label: 'Right' },
  { x: '0%', y: '100%', label: 'Bottom left' },
  { x: '50%', y: '100%', label: 'Bottom' },
  { x: '100%', y: '100%', label: 'Bottom right' },
] as const;

const ZOOM_PRESETS = [
  { label: 'Fit', value: '1' },
  { label: '1.5×', value: '1.5' },
  { label: '2×', value: '2' },
  { label: '3×', value: '3' },
] as const;

function nearestFocalPreset(x: number, y: number): (typeof FOCAL_POINT_PRESETS)[number] {
  let best: (typeof FOCAL_POINT_PRESETS)[number] = FOCAL_POINT_PRESETS[4];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const preset of FOCAL_POINT_PRESETS) {
    const dx = parsePercent(preset.x, 50) - x;
    const dy = parsePercent(preset.y, 50) - y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = preset;
      bestDistance = distance;
    }
  }
  return best;
}

type HeroImageEditDetail = {
  id: string;
  blockType?: 'EventHeader' | 'EventDescription';
  placement?: Required<ImagePlacementValue>;
  imageFit?: NonNullable<EventPageEventDescriptionProps['imageFit']>;
};

function dispatchHeroImageEdit(ownerDocument: Document | undefined, detail: HeroImageEditDetail) {
  if (!detail.id) return;
  ownerDocument?.dispatchEvent(
    new CustomEvent('tixkit:event-page-hero-image-edit', {
      detail,
    }),
  );
}

function HeroImageCanvasEditor({
  id,
  blockType = 'EventDescription',
  imageFit,
  placement,
}: {
  id: string | undefined;
  blockType?: 'EventHeader' | 'EventDescription';
  imageFit: NonNullable<EventPageEventDescriptionProps['imageFit']>;
  placement: Required<ImagePlacementValue>;
}) {
  const [dragging, setDragging] = React.useState(false);
  const [editingImage, setEditingImage] = React.useState(false);
  const editorRef = React.useRef<HTMLDivElement | null>(null);
  const openButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const activePortalRef = React.useRef<HTMLDivElement | null>(null);
  const x = parsePercent(placement.x, 50);
  const y = parsePercent(placement.y, 50);
  const scale = Number(placement.scale);
  const activePreset = nearestFocalPreset(x, y);
  const isExactPreset =
    Math.abs(parsePercent(activePreset.x, 50) - x) < 0.5 &&
    Math.abs(parsePercent(activePreset.y, 50) - y) < 0.5;
  const toolsOpen = editingImage || dragging;

  React.useEffect(() => {
    return registerOverlayPortal(openButtonRef.current, { disableDrag: true });
  }, []);

  React.useEffect(() => {
    if (!toolsOpen) return undefined;
    return registerOverlayPortal(activePortalRef.current, {
      disableDrag: true,
    });
  }, [toolsOpen]);

  function commitPlacement(next: Partial<ImagePlacementValue>) {
    if (!id) return;
    dispatchHeroImageEdit(editorRef.current?.ownerDocument, {
      id,
      blockType,
      placement: { ...placement, ...next },
    });
  }

  function commitFit(nextFit: NonNullable<EventPageEventDescriptionProps['imageFit']>) {
    if (!id) return;
    dispatchHeroImageEdit(editorRef.current?.ownerDocument, {
      id,
      blockType,
      imageFit: nextFit,
    });
  }

  function commitPointer(event: React.PointerEvent<HTMLElement>) {
    const surface = event.currentTarget.closest('[data-hero-image-surface]');
    const rect = surface?.getBoundingClientRect();
    if (!rect || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    commitPlacement({
      x: formatPercent(((event.clientX - rect.left) / rect.width) * 100),
      y: formatPercent(((event.clientY - rect.top) / rect.height) * 100),
    });
  }

  return (
    <div
      ref={editorRef}
      className={toolsOpen ? 'tk-ep-image-editor tk-ep-image-editor--active' : 'tk-ep-image-editor'}
      data-testid="hero-image-canvas-editor"
    >
      <button
        ref={openButtonRef}
        type="button"
        className="tk-ep-image-editor__open"
        aria-pressed={toolsOpen}
        aria-label="Edit image placement"
        data-puck-overlay-portal="true"
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setEditingImage(true);
        }}
      >
        <ImageIcon aria-hidden size={14} strokeWidth={2.4} />
        <span>Image</span>
      </button>
      {toolsOpen ? (
        <div
          ref={activePortalRef}
          className="tk-ep-image-editor__active-layer"
          data-puck-overlay-portal="true"
        >
          <div
            role="presentation"
            className="tk-ep-image-editor__hit"
            data-dragging={dragging ? 'true' : undefined}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
              setDragging(true);
              setEditingImage(true);
              commitPointer(event);
            }}
            onPointerMove={(event) => {
              if (!dragging) return;
              event.preventDefault();
              event.stopPropagation();
              commitPointer(event);
            }}
            onPointerUp={(event) => {
              event.preventDefault();
              event.stopPropagation();
              (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
              setDragging(false);
            }}
            onPointerCancel={(event) => {
              (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
              setDragging(false);
            }}
          />
          <div
            aria-hidden
            className="tk-ep-image-editor__reticle"
            style={{ left: placement.x, top: placement.y }}
          />
          <div
            aria-label="Image placement controls"
            className="tk-ep-image-editor__toolbar"
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="tk-ep-image-editor__toolbar-section">
              <span className="tk-ep-image-editor__label">Focus</span>
              <div className="tk-ep-image-editor__focal-grid">
                {FOCAL_POINT_PRESETS.map((preset) => {
                  const selected =
                    isExactPreset && activePreset.x === preset.x && activePreset.y === preset.y;
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      aria-label={preset.label}
                      aria-pressed={selected}
                      className={
                        selected
                          ? 'tk-ep-image-editor__focal-cell tk-ep-image-editor__focal-cell--active'
                          : 'tk-ep-image-editor__focal-cell'
                      }
                      onClick={() => commitPlacement({ x: preset.x, y: preset.y })}
                    />
                  );
                })}
              </div>
            </div>
            <div className="tk-ep-image-editor__toolbar-section tk-ep-image-editor__toolbar-section--grow">
              <span className="tk-ep-image-editor__label">Zoom {scale.toFixed(2)}×</span>
              <input
                aria-label="Image zoom"
                type="range"
                min="1"
                max="3"
                step="0.05"
                value={placement.scale}
                className="tk-ep-image-editor__zoom"
                onChange={(event) => commitPlacement({ scale: event.currentTarget.value })}
              />
              <div className="tk-ep-image-editor__chips">
                {ZOOM_PRESETS.map((preset) => {
                  const selected = Math.abs(Number(preset.value) - scale) < 0.01;
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      aria-pressed={selected}
                      className={
                        selected
                          ? 'tk-ep-image-editor__chip tk-ep-image-editor__chip--active'
                          : 'tk-ep-image-editor__chip'
                      }
                      onClick={() => commitPlacement({ scale: preset.value })}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="tk-ep-image-editor__toolbar-section">
              <span className="tk-ep-image-editor__label">Fit</span>
              <div className="tk-ep-image-editor__chips">
                {heroImageFitOptions.map((option) => {
                  const selected = imageFit === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={selected}
                      className={
                        selected
                          ? 'tk-ep-image-editor__chip tk-ep-image-editor__chip--active'
                          : 'tk-ep-image-editor__chip'
                      }
                      onClick={() =>
                        commitFit(
                          option.value as NonNullable<EventPageEventDescriptionProps['imageFit']>,
                        )
                      }
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <div className="tk-ep-image-editor__chips">
                <button
                  type="button"
                  className="tk-ep-image-editor__chip"
                  onClick={() => {
                    commitPlacement({ x: '50%', y: '50%', scale: '1' });
                    commitFit('cover');
                  }}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="tk-ep-image-editor__chip tk-ep-image-editor__chip--active"
                  onClick={() => setEditingImage(false)}
                >
                  <CheckIcon aria-hidden size={12} strokeWidth={2.6} />
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function imageUrlField(
  label: string,
  help: string,
  onUploadImage?: EventPagePuckUploadImage,
  eventMediaChoices: readonly EventPageMediaChoice[] = [],
): AnyField {
  return {
    type: 'custom',
    label,
    render: (props: CustomFieldRenderProps<string>) => (
      <ImageUrlFieldControl
        {...props}
        help={help}
        onUploadImage={onUploadImage}
        eventMediaChoices={eventMediaChoices}
      />
    ),
  };
}

function ImageUrlFieldControl({
  field,
  id,
  name,
  value,
  onChange,
  readOnly,
  help,
  onUploadImage,
  eventMediaChoices,
}: CustomFieldRenderProps & {
  help: string;
  onUploadImage?: EventPagePuckUploadImage;
  eventMediaChoices?: readonly EventPageMediaChoice[];
}) {
  const stringValue = normalizeFieldValue(value);
  const selectedEventMedia = eventMediaChoices?.find((choice) => choice.value === stringValue);
  const previewUrl =
    selectedEventMedia?.previewUrl ??
    (eventPageMediaReferenceRole(stringValue) ? undefined : stringValue);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | undefined>();

  async function uploadSelectedFile(file: File | undefined) {
    if (!file || !onUploadImage) return;
    setUploading(true);
    setUploadError(undefined);
    try {
      const result = await onUploadImage(file);
      onChange(result.url);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Unable to upload image');
    } finally {
      setUploading(false);
    }
  }

  return (
    <FieldControl field={field} help={help} htmlFor={id}>
      <input
        id={id}
        name={name}
        type="url"
        value={stringValue}
        disabled={readOnly}
        spellCheck={false}
        placeholder="https://cdn.example.com/image.jpg"
        className="tk-ep-field__input"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {eventMediaChoices && eventMediaChoices.length > 0 ? (
        <fieldset className="tk-ep-field__media-choices">
          <legend>Event media</legend>
          {eventMediaChoices.map((choice) => (
            <button
              key={choice.role}
              type="button"
              disabled={readOnly || uploading}
              aria-pressed={choice.value === stringValue}
              className="tk-ep-field__media-choice"
              onClick={() => onChange(choice.value)}
            >
              {choice.previewUrl ? (
                <img src={choice.previewUrl} alt="" className="tk-ep-field__media-choice-image" />
              ) : (
                <span className="tk-ep-field__media-choice-placeholder" aria-hidden>
                  <ImageIcon size={18} />
                </span>
              )}
              <span>{choice.label}</span>
            </button>
          ))}
        </fieldset>
      ) : null}
      {onUploadImage ? (
        <div className="tk-ep-field__chips">
          <label
            className={
              readOnly || uploading
                ? 'tk-ep-field__chip tk-ep-field__chip--disabled'
                : 'tk-ep-field__chip'
            }
          >
            {uploading ? 'Uploading...' : stringValue ? 'Change image' : 'Upload image'}
            <input
              aria-label={`${field.label ?? 'Image'} upload file`}
              name={`${name}File`}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              disabled={readOnly || uploading}
              onChange={(event) => {
                void uploadSelectedFile(event.currentTarget.files?.[0]);
                event.currentTarget.value = '';
              }}
              className="tk-ep-field__file-input"
            />
          </label>
          {stringValue ? (
            <button
              type="button"
              disabled={readOnly || uploading}
              className="tk-ep-field__chip tk-ep-field__chip--danger"
              onClick={() => onChange('')}
            >
              Remove
            </button>
          ) : null}
        </div>
      ) : null}
      {uploadError ? <p className="tk-ep-field__error">{uploadError}</p> : null}
      {previewUrl ? (
        <div className="tk-ep-field__preview">
          <img src={previewUrl} alt="" className="tk-ep-field__preview-image" />
        </div>
      ) : null}
      {!onUploadImage && stringValue ? (
        <div className="tk-ep-field__chips">
          <button
            type="button"
            disabled={readOnly}
            className="tk-ep-field__chip tk-ep-field__chip--danger"
            onClick={() => onChange('')}
          >
            Remove
          </button>
        </div>
      ) : null}
    </FieldControl>
  );
}

function normalizeLogoItems(value: unknown): NonNullable<EventPageEventDescriptionProps['logos']> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      name: normalizeFieldValue(item.name) || 'Logo',
      url: normalizeFieldValue(item.url),
      imageUrl: normalizeFieldValue(item.imageUrl),
      imageAlt: normalizeFieldValue(item.imageAlt),
    }));
}

function imageLogosField(onUploadImage?: EventPagePuckUploadImage): AnyField {
  return {
    type: 'custom',
    label: 'Logos',
    render: ({ field, id, name, value, onChange, readOnly }: CustomFieldRenderProps) => (
      <ImageLogosFieldControl
        field={field}
        id={id}
        name={name}
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        onUploadImage={onUploadImage}
      />
    ),
  };
}

function ImageLogosFieldControl({
  field,
  name,
  value,
  onChange,
  readOnly,
  onUploadImage,
}: CustomFieldRenderProps & {
  onUploadImage?: EventPagePuckUploadImage;
}) {
  const logos = normalizeLogoItems(value);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | undefined>();
  const changeLogos = onChange as unknown as (
    next: NonNullable<EventPageEventDescriptionProps['logos']>,
  ) => void;

  function updateLogo(
    index: number,
    patch: Partial<NonNullable<EventPageEventDescriptionProps['logos']>[number]>,
  ) {
    changeLogos(
      logos.map((logo, currentIndex) => (currentIndex === index ? { ...logo, ...patch } : logo)),
    );
  }

  function removeLogo(index: number) {
    changeLogos(logos.filter((_, currentIndex) => currentIndex !== index));
  }

  async function uploadLogo(file: File | undefined) {
    if (!file || !onUploadImage) return;
    setUploading(true);
    setUploadError(undefined);
    try {
      const result = await onUploadImage(file);
      changeLogos([
        ...logos,
        {
          name: file.name.replace(/\.[^.]+$/, '') || 'Logo',
          imageUrl: result.url,
          imageAlt: file.name.replace(/\.[^.]+$/, '') || 'Logo',
          url: '',
        },
      ]);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Unable to upload logo');
    } finally {
      setUploading(false);
    }
  }

  function addLogo() {
    if (readOnly || uploading) return;
    if (onUploadImage) {
      inputRef.current?.click();
      return;
    }
    changeLogos([...logos, { name: 'Logo', imageUrl: '', imageAlt: '', url: '' }]);
  }

  return (
    <FieldControl
      field={field}
      help="Click Add logo to choose an image, then adjust label, alt text, and link."
    >
      <div className="tk-ep-logo-field">
        <button
          type="button"
          className="tk-ep-field__chip"
          disabled={readOnly || uploading}
          onClick={addLogo}
        >
          {uploading ? 'Uploading...' : 'Add logo'}
        </button>
        <input
          ref={inputRef}
          name={`${name}File`}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          disabled={readOnly || uploading}
          className="tk-ep-field__file-input"
          onChange={(event) => {
            void uploadLogo(event.currentTarget.files?.[0]);
            event.currentTarget.value = '';
          }}
        />
        {uploadError ? <p className="tk-ep-field__error">{uploadError}</p> : null}
        {logos.length > 0 ? (
          <div className="tk-ep-logo-field__list">
            {logos.map((logo, index) => (
              <div
                className="tk-ep-logo-field__item"
                key={`${logo.imageUrl}-${logo.name}-${index}`}
              >
                {logo.imageUrl ? (
                  <img src={logo.imageUrl} alt="" className="tk-ep-logo-field__preview" />
                ) : (
                  <div className="tk-ep-logo-field__preview tk-ep-logo-field__preview--empty">
                    Logo
                  </div>
                )}
                <div className="tk-ep-logo-field__inputs">
                  <input
                    type="text"
                    value={logo.name ?? ''}
                    disabled={readOnly}
                    placeholder="Label"
                    className="tk-ep-field__input"
                    onChange={(event) => updateLogo(index, { name: event.currentTarget.value })}
                  />
                  <input
                    type="text"
                    value={logo.imageAlt ?? ''}
                    disabled={readOnly}
                    placeholder="Alt text"
                    className="tk-ep-field__input"
                    onChange={(event) => updateLogo(index, { imageAlt: event.currentTarget.value })}
                  />
                  <input
                    type="url"
                    value={logo.url ?? ''}
                    disabled={readOnly}
                    placeholder="https://example.com"
                    className="tk-ep-field__input"
                    onChange={(event) => updateLogo(index, { url: event.currentTarget.value })}
                  />
                </div>
                <button
                  type="button"
                  disabled={readOnly}
                  className="tk-ep-field__chip tk-ep-field__chip--danger"
                  onClick={() => removeLogo(index)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </FieldControl>
  );
}

function embedHtmlField(label: string, help: string): AnyField {
  return {
    type: 'custom',
    label,
    render: ({ field, id, name, value, onChange, readOnly }: CustomFieldRenderProps) => (
      <FieldControl field={field} help={help} htmlFor={id}>
        <textarea
          id={id}
          name={name}
          value={normalizeFieldValue(value)}
          disabled={readOnly}
          spellCheck={false}
          placeholder="<iframe ...></iframe>"
          className="tk-ep-field__textarea tk-ep-field__textarea--code"
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      </FieldControl>
    ),
  };
}

type EventPageEventDescriptionFields = AnyFields;
type EventPageEventHeaderFields = AnyFields;
type EventPageTicketsFields = AnyFields;
type EventPageButtonFields = AnyFields;
type EventPageRichTextFields = AnyFields;
type EventPageMediaFields = AnyFields;
type EventPageDetailsFields = AnyFields;

function resolveEventDescriptionFields(
  _data: {
    props?: EventPageEventDescriptionProps & { showAdvanced?: boolean };
  },
  params: { fields: EventPageEventDescriptionFields },
): AnyFields {
  return params.fields;
}

function resolveEventHeaderFields(
  data: { props?: EventPageEventHeaderProps & { showAdvanced?: boolean } },
  params: { fields: EventPageEventHeaderFields },
): AnyFields {
  let fields = params.fields;
  if (data.props?.showBrandBadge === false) {
    fields = omitFields(fields, [
      'brandLabel',
      '_sectionBadgeStyle',
      'badgeFontSize',
      'badgeTextColor',
      'badgeBackgroundColor',
      'badgeBorderColor',
    ] as const);
  }
  return fields;
}

function resolveButtonFields(
  _data: { props?: { showAdvanced?: boolean } },
  params: { fields: EventPageButtonFields },
): AnyFields {
  return params.fields;
}

function resolveRichTextFields(
  _data: { props?: { showAdvanced?: boolean } },
  params: { fields: EventPageRichTextFields },
): AnyFields {
  return params.fields;
}

function resolveMediaFields(
  data: { props?: { showAdvanced?: boolean; overlayEnabled?: boolean } },
  params: { fields: EventPageMediaFields },
): AnyFields {
  let fields = params.fields;
  if (!data.props?.overlayEnabled) {
    fields = omitFields(fields, [
      'overlayContentPosition',
      'overlayMinHeight',
      'overlayPadding',
      'imageOpacity',
      'imageOverlay',
    ]);
  }
  return fields;
}

function resolveDetailsFields(
  _data: { props?: { showAdvanced?: boolean } },
  params: { fields: EventPageDetailsFields },
): AnyFields {
  return params.fields;
}

function resolveSectionTitleAdvancedFields(
  _data: { props?: { showAdvanced?: boolean } },
  params: { fields: AnyFields },
): AnyFields {
  return params.fields;
}

function resolveTicketsFields(hasCommerceItems: boolean): AnyField {
  return function resolveTicketsFieldsForData(
    data: { props?: EventPageTicketsProps & { showAdvanced?: boolean } },
    params: { fields: EventPageTicketsFields },
  ): AnyFields {
    let fields = params.fields;
    const previewState = data.props?.previewState ?? 'live';
    const showEmptyFields =
      previewState === 'empty' || (previewState === 'live' && !hasCommerceItems);
    if (!showEmptyFields) {
      fields = omitFields(fields, [
        'emptyTitle',
        'emptyDescription',
        'emptyBackgroundColor',
        'emptyBorderColor',
      ]);
    }
    return fields;
  };
}

export function createEventPagePuckConfig(
  options: EventPagePuckConfigOptions = {},
): EventPagePuckConfig {
  const {
    allowUnsafeEmbeds = false,
    hasCommerceItems = true,
    hasProductItems = hasCommerceItems,
    onUploadImage,
    eventMediaChoices = [],
  } = options;

  return {
    categories: {
      essentials: {
        title: 'Essentials',
        components: ['EventHeader', 'EventDescription', 'Tickets', 'CheckoutCta', 'BrandFooter'],
        defaultExpanded: true,
      },
      story: {
        title: 'Story',
        components: ['RichText', 'Media', 'Divider', 'CustomEmbed'],
        defaultExpanded: true,
      },
      information: {
        title: 'Event information',
        components: ['EventDetails', 'Schedule', 'Venue', 'FAQ'],
        defaultExpanded: false,
      },
      peopleAndPartners: {
        title: 'People & partners',
        components: ['Speakers', 'Sponsors', 'SocialLinks'],
        defaultExpanded: false,
      },
      commerce: {
        title: 'Commerce',
        components: ['ProductAddOns', 'ResaleTickets'],
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
        _sectionPage: sectionField(
          'Discovery & SEO',
          'Control how this page appears in search, social previews, and event discovery.',
          'page',
          true,
        ),
        marketingSummary: {
          type: 'textarea',
          label: 'Marketing summary',
        },
        category: { type: 'text', label: 'Category' },
        tags: {
          type: 'text',
          label: 'Tags',
        },
        title: { type: 'text', label: 'SEO title' },
        description: { type: 'textarea', label: 'SEO description' },
        _sectionSocial: sectionField(
          'Images',
          'Optional overrides for discovery cards and social sharing.',
          'image',
        ),
        coverImageUrl: imageUrlField(
          'Discovery cover',
          'Used on discovery cards when set.',
          onUploadImage,
          eventMediaChoices,
        ),
        socialImageUrl: imageUrlField(
          'Social preview',
          'Used when this page is shared.',
          onUploadImage,
          eventMediaChoices,
        ),
        _sectionColors: sectionField(
          'Colors',
          'Brand colors applied across the hosted page.',
          'color',
        ),
        backgroundColor: colorField('Page background', 'Canvas color behind all sections.'),
        foregroundColor: colorField('Text color', 'Body copy, headings, and section text.'),
        accentColor: colorField('Accent color', 'Primary buttons, links, and highlights.'),
        accentForegroundColor: colorField(
          'Accent text',
          'Text on primary buttons and accent surfaces.',
        ),
        _sectionTypography: sectionField('Typography & shape', undefined, 'type'),
        fontFamily: choiceField('Body font', '', fontChoices, (value) => (
          <p className="tk-ep-field__font-preview" style={{ fontFamily: value }}>
            Doors open at 7 PM. Tickets are delivered after checkout.
          </p>
        )),
        headingFontFamily: choiceField('Heading font', '', fontChoices, (value) => (
          <p
            className="tk-ep-field__font-preview tk-ep-field__font-preview--heading"
            style={{ fontFamily: value }}
          >
            Event headline
          </p>
        )),
        radius: choiceField('Corner radius', '', radiusChoices, (value) => (
          <div className="tk-ep-field__radius-preview">
            <div style={{ borderRadius: value }} />
          </div>
        )),
      },
      defaultProps: {
        _sectionPage: true,
        _sectionSocial: true,
        _sectionColors: true,
        _sectionTypography: true,
        backgroundColor: '#ffffff',
        foregroundColor: '#111111',
        accentColor: '#111111',
        accentForegroundColor: '#ffffff',
        fontFamily: 'Inter, system-ui, sans-serif',
        headingFontFamily: 'Inter, system-ui, sans-serif',
        radius: '14px',
        marketingSummary: '',
        category: '',
        tags: '',
        coverImageUrl: '',
        socialImageUrl: '',
      },
      render: (props) => <EventPageRoot {...props} />,
    },
    components: {
      EventDescription: {
        label: 'Description',
        fields: {
          eyebrow: inlineTextField('Eyebrow'),
          title: inlineTextField('Title (h2)'),
          body: inlineTextareaField('Body'),
          _sectionImage: sectionField(
            'Image',
            'Inline or background image for the event description.',
            'image',
            true,
          ),
          imageUrl: imageUrlField(
            'Image',
            'Upload or paste a URL. Placement tools appear on the canvas when selected.',
            onUploadImage,
            eventMediaChoices,
          ),
          imageLayout: {
            type: 'select',
            label: 'Image mode',
            options: heroImageLayoutOptions,
          },
          imageFit: {
            type: 'select',
            label: 'Image fit',
            options: heroImageFitOptions,
            visible: false,
          },
          imagePosition: {
            type: 'select',
            label: 'Image anchor',
            options: heroImagePositionOptions,
            visible: false,
          },
          imagePlacement: {
            type: 'object',
            label: 'Image placement',
            visible: false,
            objectFields: {
              x: { type: 'text', label: 'X' },
              y: { type: 'text', label: 'Y' },
              scale: { type: 'text', label: 'Scale' },
            },
          },
          imageAlt: { type: 'text', label: 'Alt text' },
          imageRadius: {
            type: 'select',
            label: 'Corners',
            options: radiusPresetOptions,
          },
          overlayContentPosition: stackIconField(
            'Vertical position',
            'Where the description copy sits over a background image.',
          ),
          overlayContentHorizontalPosition: alignmentIconField(
            'Horizontal position',
            'Where the description copy sits horizontally over a background image.',
          ),
          imageOverlay: {
            type: 'slot',
            label: 'Extra overlay content',
            allow: [
              'RichText',
              'Media',
              'Button',
              'Divider',
              'Sponsors',
              'Speakers',
              'SocialLinks',
              'CustomEmbed',
            ],
          },
          _sectionLogos: sectionField(
            'Logos',
            'Brand marks overlaid on the description image.',
            'logo',
          ),
          logos: imageLogosField(onUploadImage),
          logoPosition: placementGridField(
            'Placement',
            heroLogoPositionOptions,
            'Where logos sit on the description image.',
          ),
          logoMaxHeight: lengthField('Logo height', 'Exact logo display height, e.g. 48px.'),
          logoMaxWidth: lengthField('Logo width', 'Exact logo max width, e.g. 160px.'),
          _sectionLayout: sectionField('Layout', undefined, 'layout'),
          alignment: alignmentIconField('Section align'),
          titleAlignment: alignmentIconField('Title align'),
          bodyAlignment: alignmentIconField('Body align'),
          imageAlignment: alignmentIconField('Image align'),
          spacing: segmentField('Spacing', dividerSpacingOptions),
          backgroundColor: colorField('Background', 'Optional solid color behind the section.'),
          showAdvanced: advancedToggleField(),
          _sectionTypography: sectionField('Typography', undefined, 'type'),
          eyebrowFontSize: lengthField('Eyebrow size', ''),
          eyebrowColor: colorField('Eyebrow color', ''),
          titleFontSize: lengthField('Title size', ''),
          titleColor: colorField('Title color', ''),
          bodyFontSize: lengthField('Body size', ''),
          bodyColor: colorField('Body color', ''),
          _sectionPanel: sectionField('Text panel', undefined, 'panel'),
          contentBackgroundColor: colorField('Panel background', ''),
          contentPadding: lengthField('Panel padding', ''),
          contentRadius: lengthField('Panel radius', ''),
          contentGap: lengthField('Text gap', 'Space between eyebrow, title, body, and overlay.'),
          _sectionOverlayFine: sectionField('Image fine-tune', undefined, 'tune'),
          overlayMinHeight: lengthField('Min height', ''),
          overlayPadding: lengthField('Content padding', ''),
          imageOpacity: opacityField('Image opacity', ''),
          backgroundOverlayColor: colorField('Overlay tint', ''),
          backgroundOverlayOpacity: opacityField('Tint strength', ''),
        },
        defaultProps: {
          _sectionContent: true,
          _sectionImage: true,
          _sectionLogos: true,
          _sectionLayout: true,
          showAdvanced: false,
          _sectionTypography: true,
          _sectionPanel: true,
          _sectionOverlayFine: true,
          eyebrow: '',
          title: 'About this event',
          body: '',
          imageUrl: '',
          imageAlt: '',
          alignment: 'left',
          titleAlignment: 'left',
          bodyAlignment: 'left',
          imageAlignment: 'center',
          spacing: 'normal',
          backgroundColor: '',
          imageLayout: 'inline',
          imageFit: 'cover',
          imagePosition: 'center',
          imagePositionX: '',
          imagePositionY: '',
          imagePlacement: { x: '50%', y: '50%', scale: '1' },
          imageRadius: 'soft',
          overlayContentPosition: 'center',
          overlayContentHorizontalPosition: 'left',
          overlayMinHeight: '',
          overlayPadding: '',
          imageOpacity: '1',
          backgroundOverlayColor: '#000000',
          backgroundOverlayOpacity: '0.35',
          imageOverlay: [],
          logos: [],
          logoPosition: 'top-left',
          logoSize: 'md',
          logoMaxHeight: '',
          logoMaxWidth: '',
          eyebrowFontSize: '',
          titleFontSize: '',
          bodyFontSize: '',
          eyebrowColor: '',
          titleColor: '',
          bodyColor: '',
          contentBackgroundColor: '',
          contentPadding: '',
          contentRadius: '',
          contentGap: '',
        },
        render: (props) => <EventDescriptionBlock {...props} />,
        resolveFields: resolveEventDescriptionFields as AnyField,
      },
      RichText: {
        label: 'Rich text',
        fields: {
          body: {
            ...inlineRichTextField('Body'),
            initialHeight: 280,
            options: {
              heading: { levels: [2, 3] },
            },
          },
          _sectionLayout: sectionField('Layout', undefined, 'layout', true),
          alignment: alignmentIconField('Alignment'),
          textSize: segmentField('Text size', textSizeOptions),
          spacing: segmentField('Spacing', dividerSpacingOptions),
          sectionStyle: segmentField('Section style', sectionStyleOptions),
          showAdvanced: advancedToggleField(),
          _sectionRichTextStyle: sectionField('Typography', undefined, 'type'),
          fontSize: lengthField('Font size', ''),
          lineHeight: numberOrLengthField('Line height', 'Unitless (1.5) or CSS length.'),
          paragraphGap: lengthField('Paragraph gap', ''),
        },
        defaultProps: {
          body: '<p>Add event story, highlights, or accessibility notes.</p>',
          _sectionLayout: true,
          showAdvanced: false,
          _sectionRichTextStyle: true,
          alignment: 'left',
          textSize: 'normal',
          spacing: 'normal',
          sectionStyle: 'plain',
          fontSize: '',
          lineHeight: '',
          paragraphGap: '',
        },
        render: (props) => <RichTextBlock {...props} />,
        resolveFields: resolveRichTextFields as AnyField,
      },
      Media: {
        label: 'Image / media',
        fields: {
          _sectionImage: sectionField('Image', undefined, 'image', true),
          imageUrl: imageUrlField(
            'Image',
            'Upload or paste a hosted image URL.',
            onUploadImage,
            eventMediaChoices,
          ),
          imageAlt: { type: 'text', label: 'Alt text' },
          caption: inlineTextField('Caption'),
          _sectionLayout: sectionField('Layout', undefined, 'layout'),
          aspectRatio: segmentField('Aspect ratio', aspectRatioOptions),
          width: segmentField('Width', mediaWidthOptions),
          alignment: alignmentIconField('Alignment'),
          radius: segmentField('Corners', radiusPresetOptions),
          spacing: segmentField('Spacing', dividerSpacingOptions),
          overlayEnabled: toggleField(
            'Overlay content',
            'Place extra blocks on top of this image.',
          ),
          overlayContentPosition: segmentField('Overlay position', overlayPositionOptions),
          imageOverlay: {
            type: 'slot',
            label: 'Overlay blocks',
            allow: [
              'RichText',
              'Media',
              'Button',
              'Divider',
              'Sponsors',
              'Speakers',
              'SocialLinks',
              'CustomEmbed',
            ],
          },
          showAdvanced: advancedToggleField(),
          _sectionMediaStyle: sectionField('Fine-tune', undefined, 'tune'),
          maxWidth: lengthField('Max width', '', 'px'),
          customRadius: lengthField('Exact radius', ''),
          captionFontSize: lengthField('Caption size', ''),
          overlayMinHeight: lengthField('Overlay height', ''),
          overlayPadding: lengthField('Overlay padding', ''),
          imageOpacity: opacityField('Image opacity', ''),
        },
        defaultProps: {
          _sectionImage: true,
          _sectionLayout: true,
          showAdvanced: false,
          _sectionMediaStyle: true,
          imageUrl: '',
          imageAlt: '',
          caption: '',
          aspectRatio: 'auto',
          width: 'normal',
          alignment: 'left',
          radius: 'soft',
          spacing: 'normal',
          maxWidth: '',
          customRadius: '',
          captionFontSize: '',
          overlayEnabled: false,
          overlayContentPosition: 'center',
          overlayMinHeight: '',
          overlayPadding: '',
          imageOpacity: '1',
          imageOverlay: [],
        },
        render: (props) => <MediaBlock {...props} />,
        resolveFields: resolveMediaFields as AnyField,
      },
      EventDetails: {
        label: 'Event details',
        fields: {
          title: inlineTextField('Title'),
          _sectionItems: sectionField(
            'Details',
            'Add, remove, and edit the facts shown in this section.',
            'panel',
            true,
          ),
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
          _sectionLayout: sectionField('Layout', undefined, 'layout'),
          alignment: alignmentIconField('Alignment'),
          spacing: segmentField('Spacing', dividerSpacingOptions),
          sectionStyle: segmentField('Section style', sectionStyleOptions),
          showAdvanced: advancedToggleField(),
          _sectionDetailsStyle: sectionField('Typography', undefined, 'type'),
          titleFontSize: lengthField('Title size', ''),
          titleColor: colorField('Title color', ''),
          labelFontSize: lengthField('Label size', ''),
          valueFontSize: lengthField('Value size', ''),
          labelColor: colorField('Label color', ''),
          valueColor: colorField('Value color', ''),
        },
        defaultProps: {
          title: 'Event details',
          items: [{ label: 'Date', value: 'Add date' }],
          _sectionLayout: true,
          showAdvanced: false,
          _sectionDetailsStyle: true,
          alignment: 'left',
          spacing: 'normal',
          sectionStyle: 'plain',
          titleFontSize: '',
          titleColor: '',
          labelFontSize: '',
          valueFontSize: '',
          labelColor: '',
          valueColor: '',
        },
        render: (props) => <EventDetailsBlock {...props} />,
        resolveFields: resolveDetailsFields as AnyField,
      },
      Schedule: {
        label: 'Schedule',
        fields: {
          title: inlineTextField('Title'),
          _sectionItems: sectionField(
            'Schedule items',
            'Manage session times, locations, and descriptions.',
            'panel',
            true,
          ),
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
            defaultItemProps: {
              title: 'Session',
              startsAt: '',
              endsAt: '',
              location: '',
              description: '',
            },
            getItemSummary: (item) => item.title || 'Schedule item',
          },
          _sectionLayout: sectionField('Layout', undefined, 'layout'),
          alignment: alignmentIconField('Alignment'),
          spacing: segmentField('Spacing', dividerSpacingOptions),
          sectionStyle: segmentField('Section style', sectionStyleOptions),
          showAdvanced: advancedToggleField(),
          _sectionTitleStyle: sectionField('Typography', undefined, 'type'),
          titleFontSize: lengthField('Title size', ''),
          titleColor: colorField('Title color', ''),
        },
        defaultProps: {
          title: 'Schedule',
          items: [{ title: 'Event starts', startsAt: '' }],
          _sectionLayout: true,
          showAdvanced: false,
          _sectionTitleStyle: true,
          alignment: 'left',
          spacing: 'normal',
          sectionStyle: 'plain',
          titleFontSize: '',
          titleColor: '',
        },
        render: (props) => <ScheduleBlock {...props} />,
        resolveFields: resolveSectionTitleAdvancedFields as AnyField,
      },
      Venue: {
        label: 'Venue',
        fields: {
          title: inlineTextField('Title'),
          venueName: inlineTextField('Venue name'),
          address: inlineTextareaField('Address'),
          mapUrl: urlField('Map link', 'Maps, venue, or directions URL.'),
          _sectionLayout: sectionField('Layout', undefined, 'layout'),
          alignment: alignmentIconField('Alignment'),
          spacing: segmentField('Spacing', dividerSpacingOptions),
          sectionStyle: segmentField('Section style', sectionStyleOptions),
          showAdvanced: advancedToggleField(),
          _sectionTitleStyle: sectionField('Typography', undefined, 'type'),
          titleFontSize: lengthField('Title size', ''),
          titleColor: colorField('Title color', ''),
        },
        defaultProps: {
          title: 'Venue',
          venueName: 'Venue to be announced',
          address: '',
          mapUrl: '',
          _sectionLayout: true,
          showAdvanced: false,
          _sectionTitleStyle: true,
          alignment: 'left',
          spacing: 'normal',
          sectionStyle: 'plain',
          titleFontSize: '',
          titleColor: '',
        },
        render: (props) => <VenueBlock {...props} />,
        resolveFields: resolveSectionTitleAdvancedFields as AnyField,
      },
      FAQ: {
        label: 'FAQ',
        fields: {
          title: inlineTextField('Title'),
          _sectionItems: sectionField(
            'Questions & answers',
            'Add, remove, and edit FAQ entries.',
            'panel',
            true,
          ),
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
          _sectionLayout: sectionField('Layout', undefined, 'layout'),
          alignment: alignmentIconField('Alignment'),
          spacing: segmentField('Spacing', dividerSpacingOptions),
          sectionStyle: segmentField('Section style', sectionStyleOptions),
          showAdvanced: advancedToggleField(),
          _sectionTitleStyle: sectionField('Typography', undefined, 'type'),
          titleFontSize: lengthField('Title size', ''),
          titleColor: colorField('Title color', ''),
        },
        defaultProps: {
          title: 'FAQ',
          items: [{ question: 'What should guests know?', answer: 'Add an answer.' }],
          _sectionLayout: true,
          showAdvanced: false,
          _sectionTitleStyle: true,
          alignment: 'left',
          spacing: 'normal',
          sectionStyle: 'plain',
          titleFontSize: '',
          titleColor: '',
        },
        render: ({ puck, ...props }) => <FAQBlock {...props} editorPreview={puck.isEditing} />,
        resolveFields: resolveSectionTitleAdvancedFields as AnyField,
      },
      Sponsors: {
        label: 'Sponsors',
        fields: {
          title: inlineTextField('Title'),
          _sectionItems: sectionField(
            'Sponsors',
            'Manage sponsor names, logos, and links.',
            'logo',
            true,
          ),
          items: {
            type: 'array',
            label: 'Sponsors',
            arrayFields: {
              name: { type: 'text', label: 'Name' },
              url: urlField('Sponsor link', 'Optional destination for this sponsor.'),
              imageUrl: imageUrlField('Logo', 'Hosted sponsor logo URL.', onUploadImage),
              imageAlt: { type: 'text', label: 'Logo alt text' },
            },
            defaultItemProps: {
              name: 'Sponsor',
              url: '',
              imageUrl: '',
              imageAlt: '',
            },
            getItemSummary: (item) => item.name || 'Sponsor',
          },
          _sectionLayout: sectionField('Layout', undefined, 'layout'),
          alignment: alignmentIconField('Alignment'),
          spacing: segmentField('Spacing', dividerSpacingOptions),
          sectionStyle: segmentField('Section style', sectionStyleOptions),
          showAdvanced: advancedToggleField(),
          _sectionTitleStyle: sectionField('Typography', undefined, 'type'),
          titleFontSize: lengthField('Title size', ''),
          titleColor: colorField('Title color', ''),
        },
        defaultProps: {
          title: 'Sponsors',
          items: [],
          _sectionLayout: true,
          showAdvanced: false,
          _sectionTitleStyle: true,
          alignment: 'left',
          spacing: 'normal',
          sectionStyle: 'plain',
          titleFontSize: '',
          titleColor: '',
        },
        render: (props) => <SponsorsBlock {...props} />,
        resolveFields: resolveSectionTitleAdvancedFields as AnyField,
      },
      Speakers: {
        label: 'Speakers',
        fields: {
          title: inlineTextField('Title'),
          _sectionItems: sectionField(
            'People',
            'Manage names, roles, biographies, headshots, and profile links.',
            'panel',
            true,
          ),
          items: {
            type: 'array',
            label: 'Speakers',
            arrayFields: {
              name: { type: 'text', label: 'Name' },
              role: { type: 'text', label: 'Role' },
              bio: { type: 'textarea', label: 'Bio' },
              imageUrl: imageUrlField('Headshot', 'Hosted speaker image URL.', onUploadImage),
              imageAlt: { type: 'text', label: 'Image alt text' },
              url: urlField('Profile link', 'Optional website, bio, or social profile.'),
            },
            defaultItemProps: {
              name: 'Speaker',
              role: '',
              bio: '',
              imageUrl: '',
              imageAlt: '',
              url: '',
            },
            getItemSummary: (item) => item.name || 'Speaker',
          },
          _sectionLayout: sectionField('Layout', undefined, 'layout'),
          alignment: alignmentIconField('Alignment'),
          spacing: segmentField('Spacing', dividerSpacingOptions),
          sectionStyle: segmentField('Section style', sectionStyleOptions),
          showAdvanced: advancedToggleField(),
          _sectionTitleStyle: sectionField('Typography', undefined, 'type'),
          titleFontSize: lengthField('Title size', ''),
          titleColor: colorField('Title color', ''),
        },
        defaultProps: {
          title: 'Speakers',
          items: [],
          _sectionLayout: true,
          showAdvanced: false,
          _sectionTitleStyle: true,
          alignment: 'left',
          spacing: 'normal',
          sectionStyle: 'plain',
          titleFontSize: '',
          titleColor: '',
        },
        render: (props) => <SpeakersBlock {...props} />,
        resolveFields: resolveSectionTitleAdvancedFields as AnyField,
      },
      Button: {
        label: 'Button',
        fields: {
          label: inlineTextField('Label'),
          url: urlField('Button link', 'Where this button should send guests.'),
          _sectionLayout: sectionField('Appearance', undefined, 'layout', true),
          style: segmentField('Style', buttonStyleOptions),
          alignment: alignmentIconField('Alignment'),
          size: segmentField('Size', buttonSizeOptions),
          width: segmentField('Width', buttonWidthOptions),
          radius: segmentField('Corners', buttonRadiusOptions),
          textStyle: segmentField('Text style', buttonTextStyleOptions),
          openInNewTab: toggleField('Open in new tab'),
          showAdvanced: advancedToggleField(),
          _sectionButtonStyle: sectionField('Fine-tune', undefined, 'tune'),
          backgroundColor: colorField('Background', ''),
          textColor: colorField('Text', ''),
          borderColor: colorField('Border', ''),
          fontSize: lengthField('Label size', ''),
          lineHeight: numberOrLengthField('Line height', ''),
          letterSpacing: lengthField('Letter spacing', ''),
          paddingX: lengthField('Padding X', ''),
          paddingY: lengthField('Padding Y', ''),
          minHeight: lengthField('Min height', ''),
          borderWidth: lengthField('Border width', ''),
          customRadius: lengthField('Exact radius', ''),
        },
        defaultProps: {
          label: 'Learn more',
          url: '#',
          _sectionLayout: true,
          showAdvanced: false,
          _sectionButtonStyle: true,
          style: 'primary',
          alignment: 'left',
          size: 'medium',
          width: 'auto',
          radius: 'soft',
          textStyle: 'normal',
          backgroundColor: '',
          textColor: '',
          borderColor: '',
          openInNewTab: false,
          fontSize: '',
          paddingX: '',
          paddingY: '',
          minHeight: '',
          borderWidth: '',
          customRadius: '',
          letterSpacing: '',
          lineHeight: '',
        },
        render: (props) => <ButtonBlock {...props} />,
        resolveFields: resolveButtonFields as AnyField,
      },
      Divider: {
        label: 'Divider',
        fields: {
          spacing: segmentField('Spacing', dividerSpacingOptions),
        },
        defaultProps: {
          spacing: 'normal',
        },
        render: (props) => <DividerBlock {...props} />,
      },
      SocialLinks: {
        label: 'Social links',
        fields: {
          title: inlineTextField('Title'),
          _sectionItems: sectionField(
            'Links',
            'Manage link labels and destinations.',
            'panel',
            true,
          ),
          links: {
            type: 'array',
            label: 'Links',
            min: 1,
            arrayFields: {
              label: { type: 'text', label: 'Label' },
              url: urlField('Link URL', 'Social, website, email, or phone link.'),
            },
            defaultItemProps: { label: 'Link', url: '' },
            getItemSummary: (item) => item.label || 'Link',
          },
          _sectionLayout: sectionField('Layout', undefined, 'layout'),
          alignment: alignmentIconField('Alignment'),
          spacing: segmentField('Spacing', dividerSpacingOptions),
          sectionStyle: segmentField('Section style', sectionStyleOptions),
          showAdvanced: advancedToggleField(),
          _sectionTitleStyle: sectionField('Typography', undefined, 'type'),
          titleFontSize: lengthField('Title size', ''),
          titleColor: colorField('Title color', ''),
        },
        defaultProps: {
          title: 'Follow us',
          links: [{ label: 'Instagram', url: '' }],
          _sectionLayout: true,
          showAdvanced: false,
          _sectionTitleStyle: true,
          alignment: 'left',
          spacing: 'normal',
          sectionStyle: 'plain',
          titleFontSize: '',
          titleColor: '',
        },
        render: (props) => <SocialLinksBlock {...props} />,
        resolveFields: resolveSectionTitleAdvancedFields as AnyField,
      },
      CustomEmbed: {
        label: 'Custom embed',
        fields: allowUnsafeEmbeds
          ? {
              _sectionEmbed: sectionField(
                'Embed',
                'Only renders after approval is enabled.',
                'panel',
                true,
              ),
              html: embedHtmlField('Embed HTML', 'Paste provider embed code.'),
              allowUnsafeEmbed: toggleField(
                'Approved embed',
                'Only enable after you trust this embed code.',
              ),
            }
          : {
              _sectionEmbed: sectionField(
                'Restricted embed',
                'Settings permission is required to edit or approve custom HTML.',
                'panel',
                true,
              ),
              html: {
                ...embedHtmlField('Embed HTML', 'Restricted'),
                visible: false,
              },
              allowUnsafeEmbed: {
                ...toggleField('Approved embed'),
                visible: false,
              },
            },
        defaultProps: {
          _sectionEmbed: true,
          html: '',
          allowUnsafeEmbed: false,
        },
        render: (props) => <CustomEmbedBlock {...props} />,
      },
      EventHeader: {
        label: 'Event header',
        fields: {
          title: inlineTextField('Title (h1)'),
          description: inlineTextareaField('Description'),
          _sectionVisibility: sectionField('Visibility', undefined, 'tune', true),
          showBrandBadge: toggleField(
            'Show brand badge',
            'Show the badge above the header title.',
            {
              defaultEnabled: true,
            },
          ),
          brandLabel: inlineTextField('Badge label'),
          showDate: toggleField('Show date', '', { defaultEnabled: true }),
          showTimezone: toggleField('Show timezone', '', {
            defaultEnabled: true,
          }),
          showVenue: toggleField('Show venue', '', { defaultEnabled: true }),
          _sectionImage: sectionField(
            'Background image',
            'Image, overlay, and focus controls for the event header.',
            'image',
          ),
          imageUrl: imageUrlField(
            'Background image',
            'Upload or paste a URL. Placement tools appear on the canvas when selected.',
            onUploadImage,
            eventMediaChoices,
          ),
          imageFit: {
            type: 'select',
            label: 'Image fit',
            options: heroImageFitOptions,
            visible: false,
          },
          imagePosition: {
            type: 'select',
            label: 'Image anchor',
            options: heroImagePositionOptions,
            visible: false,
          },
          imagePlacement: {
            type: 'object',
            label: 'Image placement',
            visible: false,
            objectFields: {
              x: { type: 'text', label: 'X' },
              y: { type: 'text', label: 'Y' },
              scale: { type: 'text', label: 'Scale' },
            },
          },
          imageAlt: { type: 'text', label: 'Alt text' },
          overlayContentPosition: stackIconField(
            'Vertical position',
            'Where header copy sits vertically over the background image.',
          ),
          overlayContentHorizontalPosition: alignmentIconField(
            'Horizontal position',
            'Where header copy sits horizontally over the background image.',
          ),
          overlayMinHeight: lengthField(
            'Header height',
            'Minimum image header height, e.g. 520px.',
          ),
          overlayPadding: lengthField('Outer padding', 'Padding around the header content.'),
          contentPadding: lengthField('Copy padding', 'Padding inside the header copy group.'),
          contentGap: lengthField(
            'Copy gap',
            'Space between badge, title, description, and details.',
          ),
          _sectionLogos: sectionField('Logos', 'Brand marks overlaid on the header image.', 'logo'),
          logos: imageLogosField(onUploadImage),
          logoPosition: placementGridField(
            'Placement',
            heroLogoPositionOptions,
            'Where logos sit on the header image.',
          ),
          logoMaxHeight: lengthField('Logo height', 'Exact logo display height, e.g. 48px.'),
          logoMaxWidth: lengthField('Logo width', 'Exact logo max width, e.g. 160px.'),
          _sectionMetaStyle: sectionField('Details style', undefined, 'type'),
          metaFontSize: lengthField('Details text size', ''),
          metaColor: colorField('Details text', ''),
          metaIconColor: colorField('Details icons', ''),
          metaGap: lengthField('Details gap', 'Space between date, timezone, and venue.'),
          showAdvanced: advancedToggleField(),
          _sectionImageFine: sectionField('Image fine-tune', undefined, 'tune'),
          imageOpacity: opacityField('Image opacity', ''),
          backgroundOverlayColor: colorField('Overlay tint', ''),
          backgroundOverlayOpacity: opacityField('Tint strength', ''),
          _sectionTitleStyle: sectionField('Title style', undefined, 'type'),
          titleFontSize: lengthField('Title size', ''),
          titleColor: colorField('Title color', ''),
          descriptionFontSize: lengthField('Description size', ''),
          descriptionColor: colorField('Description color', ''),
          _sectionBadgeStyle: sectionField('Badge style', undefined, 'panel'),
          badgeFontSize: lengthField('Badge text size', ''),
          badgeTextColor: colorField('Badge text', ''),
          badgeBackgroundColor: colorField('Badge background', ''),
          badgeBorderColor: colorField('Badge border', ''),
        },
        defaultProps: {
          _sectionContent: true,
          _sectionVisibility: true,
          _sectionImage: true,
          _sectionLogos: true,
          _sectionMetaStyle: true,
          showAdvanced: false,
          _sectionImageFine: true,
          _sectionTitleStyle: true,
          _sectionBadgeStyle: true,
          brandLabel: 'Event',
          title: 'Event title',
          description: '',
          startsAtLabel: 'Date to be announced',
          timezone: '',
          venueName: '',
          showBrandBadge: true,
          showDate: true,
          showTimezone: true,
          showVenue: true,
          imageUrl: '',
          imageAlt: '',
          imageFit: 'cover',
          imagePosition: 'center',
          imagePositionX: '',
          imagePositionY: '',
          imagePlacement: { x: '50%', y: '50%', scale: '1' },
          overlayContentPosition: 'center',
          overlayContentHorizontalPosition: 'left',
          overlayMinHeight: '',
          overlayPadding: '',
          contentPadding: '',
          contentGap: '',
          imageOpacity: '1',
          backgroundOverlayColor: '#000000',
          backgroundOverlayOpacity: '0.35',
          logos: [],
          logoPosition: 'top-left',
          logoSize: 'md',
          logoMaxHeight: '48px',
          logoMaxWidth: '160px',
          titleFontSize: '',
          titleColor: '',
          descriptionFontSize: '',
          descriptionColor: '',
          metaFontSize: '',
          metaColor: '',
          metaIconColor: '',
          metaGap: '',
          badgeFontSize: '',
          badgeTextColor: '',
          badgeBackgroundColor: '',
          badgeBorderColor: '',
        },
        render: (props) => <EventHeaderBlock {...props} />,
        resolveFields: resolveEventHeaderFields as AnyField,
      },
      Tickets: {
        label: 'Tickets',
        fields: {
          title: inlineTextField('Section title (h2)'),
          _sectionLayout: sectionField('Layout', undefined, 'layout', true),
          alignment: alignmentIconField('Align'),
          spacing: segmentField('Section padding', dividerSpacingOptions),
          sectionGap: lengthField('Title gap', 'Space under the section title.'),
          itemGap: lengthField('List gap', 'Space between ticket cards.'),
          itemPadding: lengthField('Card padding', 'Inner padding of each ticket card.'),
          _sectionCanvas: sectionField('Canvas', undefined, 'tune'),
          previewState: segmentField('Preview data', commercePreviewStateOptions),
          emptyTitle: inlineTextField('Empty title'),
          emptyDescription: inlineTextareaField('Empty description'),
          showAdvanced: advancedToggleField(),
          _sectionTicketStyle: sectionField('Style', undefined, 'tune'),
          titleFontSize: lengthField('Title size', ''),
          titleColor: colorField('Title color', ''),
          itemRadius: lengthField('Card radius', ''),
          itemBackgroundColor: colorField('Card background', ''),
          itemBorderColor: colorField('Card border', ''),
          itemTextColor: colorField('Card text', ''),
          itemDescriptionColor: colorField('Description color', ''),
          priceTextColor: colorField('Price color', ''),
          emptyBackgroundColor: colorField('Empty background', ''),
          emptyBorderColor: colorField('Empty border', ''),
        },
        defaultProps: {
          title: 'Tickets',
          _sectionLayout: true,
          showAdvanced: false,
          _sectionTicketStyle: true,
          _sectionCanvas: true,
          alignment: 'left',
          spacing: 'normal',
          previewState: 'live',
          emptyTitle: 'No tickets available',
          emptyDescription: 'Ticket sales have not opened for this event yet. Check back soon.',
          titleFontSize: '',
          titleColor: '',
          sectionGap: '16px',
          itemGap: '12px',
          itemPadding: '',
          itemRadius: '',
          itemBackgroundColor: '',
          itemBorderColor: '',
          itemTextColor: '',
          itemDescriptionColor: '',
          priceTextColor: '',
          emptyBackgroundColor: '',
          emptyBorderColor: '',
        },
        render: (props) => <TicketsBlock {...props} />,
        resolveFields: resolveTicketsFields(hasCommerceItems),
      },
      ProductAddOns: {
        label: 'Product add-ons',
        fields: {
          title: inlineTextField('Section title (h2)'),
          _sectionLayout: sectionField('Layout', undefined, 'layout', true),
          alignment: alignmentIconField('Align'),
          spacing: segmentField('Section padding', dividerSpacingOptions),
          previewState: segmentField('Preview data', commercePreviewStateOptions),
          emptyTitle: inlineTextField('Empty title'),
          emptyDescription: inlineTextareaField('Empty description'),
          showAdvanced: advancedToggleField(),
          _sectionProductStyle: sectionField('Style', undefined, 'tune'),
          titleFontSize: lengthField('Title size', ''),
          titleColor: colorField('Title color', ''),
          itemRadius: lengthField('Card radius', ''),
          itemBackgroundColor: colorField('Card background', ''),
          itemBorderColor: colorField('Card border', ''),
          itemTextColor: colorField('Card text', ''),
          itemDescriptionColor: colorField('Description color', ''),
          priceTextColor: colorField('Price color', ''),
        },
        defaultProps: {
          title: 'Add-ons',
          _sectionLayout: true,
          showAdvanced: false,
          _sectionProductStyle: true,
          alignment: 'left',
          spacing: 'normal',
          previewState: 'live',
          emptyTitle: 'No add-ons available',
          emptyDescription: 'Optional products will appear here when available.',
          titleFontSize: '',
          titleColor: '',
          itemRadius: '',
          itemBackgroundColor: '',
          itemBorderColor: '',
          itemTextColor: '',
          itemDescriptionColor: '',
          priceTextColor: '',
        },
        render: (props) => <ProductAddOnsBlock {...props} />,
        resolveFields: resolveTicketsFields(hasProductItems),
      },
      ResaleTickets: {
        label: 'Resale tickets',
        fields: {
          title: inlineTextField('Section title (h2)'),
          previewState: {
            type: 'select',
            label: 'Canvas state',
            options: commercePreviewStateOptions,
          },
          badgeLabel: inlineTextField('Badge label'),
        },
        defaultProps: {
          title: 'Resale tickets',
          previewState: 'live',
          badgeLabel: 'Verified listings',
        },
        render: (props) => <ResaleTicketsBlock {...props} />,
      },
      CheckoutCta: {
        label: 'Get tickets CTA',
        fields: {
          label: inlineTextField('Button label'),
          supportingText: inlineTextField('Supporting text'),
        },
        defaultProps: {
          label: 'Get tickets',
          supportingText: 'Secure checkout powered by Tixkit',
        },
        render: (props) => <CheckoutCtaBlock {...props} />,
      },
      BrandFooter: {
        label: 'Brand footer',
        fields: {
          label: inlineTextField('Footer label'),
        },
        defaultProps: {
          label: '',
        },
        render: (props) => <BrandFooterBlock {...props} />,
      },
    },
  };
}

export const eventPagePuckConfig: EventPagePuckConfig = createEventPagePuckConfig();

export function EventPageRender({
  document,
  data,
  className,
  brandVariables,
  metadata,
  runtime,
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
          settings: {
            locale: 'en',
            discovery: { summary: 'Event page', tags: [] },
          },
        } satisfies EventPageDocument),
      validationOptions,
    );
    if (!result.valid) return <>{fallback}</>;
  }

  const tree = (
    <div
      className={joinClassNames(EVENT_PAGE_PUCK_STYLES_CLASS, className)}
      data-provider={PUCK_EVENT_PAGE_PROVIDER}
      data-testid="preview-surface"
      style={eventPageBrandVariablesToCssProperties(brandVariables)}
    >
      <Render
        config={eventPagePuckConfig}
        data={renderData as EventPagePuckCoreData}
        metadata={metadata}
      />
    </div>
  );

  if (!runtime) return tree;
  return <EventPageRuntimeProvider value={runtime}>{tree}</EventPageRuntimeProvider>;
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
      className="tixkit-event-page bg-background text-foreground min-h-svh"
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
      <div className="tk-ep-page-frame mx-auto w-full max-w-6xl px-4 py-10 sm:px-8 lg:px-10">
        {children}
      </div>
    </div>
  );
}

function sectionClassNames(
  baseClassName: string,
  design: {
    alignment?: 'left' | 'center' | 'right';
    spacing?: 'compact' | 'normal' | 'loose';
    sectionStyle?: 'plain' | 'outlined' | 'filled';
  },
  extraClassNames: string[] = [],
) {
  const { alignment = 'left', spacing = 'normal', sectionStyle = 'plain' } = design;
  return joinClassNames(
    baseClassName,
    `tk-ep-align-${alignment}`,
    `tk-ep-section-spacing-${spacing}`,
    `tk-ep-section-style-${sectionStyle}`,
    ...extraClassNames,
  );
}

function styleFromLengths(values: CSSProperties): CSSProperties {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => typeof value === 'string' && value.length > 0),
  ) as CSSProperties;
}

function alignmentStyle(alignment?: 'left' | 'center' | 'right'): CSSProperties {
  return alignment ? { textAlign: alignment } : {};
}

function overlayClassName(
  baseClassName: string,
  position: 'top' | 'center' | 'bottom' = 'center',
): string {
  return joinClassNames(baseClassName, `tk-ep-overlay-position-${position}`);
}

function resolveHeroImagePlacement({
  imagePlacement,
  imagePosition,
  imagePositionX,
  imagePositionY,
}: Pick<
  EventPageEventDescriptionProps,
  'imagePlacement' | 'imagePosition' | 'imagePositionX' | 'imagePositionY'
>) {
  const normalized = normalizeHeroImagePlacement(imagePlacement);
  const hasPlacement = Boolean(imagePlacement?.x || imagePlacement?.y || imagePlacement?.scale);
  const objectPosition =
    hasPlacement || imagePositionX || imagePositionY
      ? `${imagePlacement?.x || imagePositionX || normalized.x} ${
          imagePlacement?.y || imagePositionY || normalized.y
        }`
      : imagePosition;
  return {
    objectPosition,
    transform: normalized.scale !== '1' ? `scale(${normalized.scale})` : undefined,
    transformOrigin: objectPosition,
    x: hasPlacement || imagePositionX ? imagePlacement?.x || imagePositionX || normalized.x : '50%',
    y: hasPlacement || imagePositionY ? imagePlacement?.y || imagePositionY || normalized.y : '50%',
    scale: normalized.scale,
  };
}

function trimmedText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

const EMPTY_EVENT_DESCRIPTION_LOGOS: NonNullable<EventPageEventDescriptionProps['logos']> = [];

function renderImageLogoStrip({
  logos,
  logoPosition = 'top-left',
  logoSize = 'md',
  logoMaxHeight,
  logoMaxWidth,
  ariaLabel,
  extraClassName,
  outlineTargetPrefix,
}: {
  logos?: EventPageEventDescriptionProps['logos'];
  logoPosition?: EventPageEventDescriptionProps['logoPosition'];
  logoSize?: EventPageEventDescriptionProps['logoSize'];
  logoMaxHeight?: string;
  logoMaxWidth?: string;
  ariaLabel: string;
  extraClassName?: string;
  outlineTargetPrefix?: string;
}) {
  const visibleLogos = Array.isArray(logos)
    ? logos.filter((logo) => Boolean(logo?.imageUrl || logo?.name))
    : [];
  if (visibleLogos.length === 0) return null;

  const logoSizeClass =
    logoSize === 'sm' || logoSize === 'lg'
      ? `tk-ep-hero__logos--${logoSize}`
      : 'tk-ep-hero__logos--md';
  const logoStripStyle = {
    ...(logoMaxHeight ? { '--tk-ep-logo-max-height': logoMaxHeight } : {}),
    ...(logoMaxWidth ? { '--tk-ep-logo-max-width': logoMaxWidth } : {}),
  } as CSSProperties;

  return (
    <ul
      className={joinClassNames(
        'tk-ep-hero__logos',
        extraClassName,
        `tk-ep-hero__logos--${logoPosition ?? 'top-left'}`,
        logoSizeClass,
      )}
      style={logoStripStyle}
      aria-label={ariaLabel}
      data-event-page-outline-target={outlineTargetPrefix}
    >
      {visibleLogos.map((logo, index) => {
        const content = logo.imageUrl ? (
          <img src={logo.imageUrl} alt={logo.imageAlt || logo.name || 'Logo'} loading="lazy" />
        ) : (
          <span>{logo.name}</span>
        );
        return (
          <li
            key={`${logo.name ?? 'logo'}-${index}`}
            data-event-page-outline-target={
              outlineTargetPrefix ? `${outlineTargetPrefix}:${index}` : undefined
            }
          >
            {logo.url ? (
              <a href={logo.url} rel="noreferrer">
                {content}
              </a>
            ) : (
              content
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function EventDescriptionBlock({
  id,
  eyebrow,
  title,
  body,
  imageUrl,
  imageAlt,
  alignment = 'left',
  titleAlignment,
  bodyAlignment,
  imageAlignment = 'center',
  spacing = 'normal',
  backgroundColor,
  imageLayout = 'inline',
  imageFit = 'cover',
  imagePosition = 'center',
  imagePositionX,
  imagePositionY,
  imagePlacement,
  imageRadius = 'soft',
  overlayContentPosition = 'center',
  overlayContentHorizontalPosition = 'left',
  overlayMinHeight,
  overlayPadding,
  imageOpacity,
  backgroundOverlayColor,
  backgroundOverlayOpacity,
  imageOverlay: ImageOverlay,
  logos = EMPTY_EVENT_DESCRIPTION_LOGOS,
  logoPosition = 'top-left',
  logoSize = 'md',
  logoMaxHeight,
  logoMaxWidth,
  eyebrowFontSize,
  titleFontSize,
  bodyFontSize,
  eyebrowColor,
  titleColor,
  bodyColor,
  contentBackgroundColor,
  contentPadding,
  contentRadius,
  contentGap,
  puck,
}: WithBlockId<EventPageEventDescriptionProps> & {
  puck?: { isEditing?: boolean };
}) {
  const renderImageOverlay = (className: string, minEmptyHeight: number) =>
    typeof ImageOverlay === 'function'
      ? (ImageOverlay as OverlaySlotRender)({ className, minEmptyHeight })
      : null;
  const runtime = useEventPageRuntime();
  const resolvedImage = resolveEventPageImage(imageUrl, imageAlt, runtime);
  const resolvedImageUrl = resolvedImage?.url;
  const resolvedImageAlt = resolvedImage?.altText ?? '';
  const showCanvasImageEditor = Boolean(
    puck?.isEditing && runtime.interactive === false && Boolean(resolvedImageUrl),
  );
  const sectionStyle: CSSProperties | undefined = backgroundColor ? { backgroundColor } : undefined;
  const resolvedPlacement = resolveHeroImagePlacement({
    imagePlacement,
    imagePosition,
    imagePositionX,
    imagePositionY,
  });
  const imageStyle = {
    objectFit: imageFit,
    objectPosition: resolvedPlacement.objectPosition,
    transform: resolvedPlacement.transform,
    transformOrigin: resolvedPlacement.transformOrigin,
  } satisfies CSSProperties;
  const editorPlacementValue = normalizeHeroImagePlacement({
    x: resolvedPlacement.x,
    y: resolvedPlacement.y,
    scale: resolvedPlacement.scale,
  });
  const canvasImageEditor = showCanvasImageEditor ? (
    <HeroImageCanvasEditor
      id={id}
      blockType="EventDescription"
      imageFit={imageFit ?? 'cover'}
      placement={editorPlacementValue}
    />
  ) : null;
  const logoStrip = renderImageLogoStrip({
    logos,
    logoPosition,
    logoSize,
    logoMaxHeight,
    logoMaxWidth,
    ariaLabel: 'Description logos',
    extraClassName: 'tk-ep-event-description__logos',
    outlineTargetPrefix: `${id}:Logos`,
  });
  const copy = (
    <div
      className={joinClassNames(
        'tk-ep-event-description__copy',
        `tk-ep-align-${overlayContentHorizontalPosition}`,
      )}
      style={{
        ...styleFromLengths({
          gap: contentGap,
          padding: contentPadding,
          borderRadius: contentRadius,
        }),
        ...(contentBackgroundColor ? { backgroundColor: contentBackgroundColor } : {}),
      }}
    >
      {eyebrow ? (
        <p
          className="tk-ep-eyebrow"
          data-event-page-outline-target={`${id}:eyebrow`}
          style={{
            ...styleFromLengths({ fontSize: eyebrowFontSize }),
            ...alignmentStyle(titleAlignment ?? alignment),
            ...(eyebrowColor ? { color: eyebrowColor } : {}),
          }}
        >
          {eyebrow}
        </p>
      ) : null}
      {title ? (
        <h2
          data-event-page-outline-target={`${id}:title`}
          style={{
            ...styleFromLengths({ fontSize: titleFontSize }),
            ...alignmentStyle(titleAlignment ?? alignment),
            ...(titleColor ? { color: titleColor } : {}),
          }}
        >
          {title}
        </h2>
      ) : null}
      {body ? (
        <p
          className="tk-ep-event-description__body"
          data-event-page-outline-target={`${id}:body`}
          style={{
            ...styleFromLengths({ fontSize: bodyFontSize }),
            ...alignmentStyle(bodyAlignment ?? alignment),
            ...(bodyColor ? { color: bodyColor } : {}),
          }}
        >
          {body}
        </p>
      ) : null}
    </div>
  );
  const overlaySurfaceStyle = {
    ...styleFromLengths({
      minHeight: overlayMinHeight,
      padding: overlayPadding,
    }),
    ...(imageOpacity ? { '--tk-ep-image-opacity': imageOpacity } : {}),
    ...(backgroundOverlayColor ? { '--tk-ep-overlay-color': backgroundOverlayColor } : {}),
    ...(backgroundOverlayOpacity ? { '--tk-ep-overlay-opacity': backgroundOverlayOpacity } : {}),
  } as CSSProperties;

  if (imageLayout === 'background' && resolvedImageUrl) {
    return (
      <section
        className={joinClassNames(
          'tk-ep-event-description',
          'tk-ep-event-description--background',
          `tk-ep-align-${alignment}`,
          `tk-ep-section-spacing-${spacing}`,
        )}
        data-block-id={id}
        data-block-type="EventDescription"
        style={sectionStyle}
      >
        <div
          data-hero-image-surface
          className={overlayClassName(
            joinClassNames(
              'tk-ep-overlay-surface tk-ep-event-description__overlay',
              showCanvasImageEditor ? 'tk-ep-image-surface--editing' : undefined,
            ),
            overlayContentPosition,
          )}
          style={overlaySurfaceStyle}
        >
          <img
            className={`tk-ep-overlay-image tk-ep-radius-${imageRadius}`}
            data-event-page-outline-target={`${id}:image`}
            src={resolvedImageUrl}
            alt={resolvedImageAlt}
            loading="lazy"
            style={imageStyle}
          />
          {logoStrip}
          <div
            className={joinClassNames(
              'tk-ep-overlay-content',
              `tk-ep-overlay-align-${overlayContentHorizontalPosition}`,
            )}
            data-event-page-outline-target={`${id}:imageOverlay`}
          >
            {copy}
            {renderImageOverlay('tk-ep-overlay-slot', 96)}
          </div>
          {canvasImageEditor}
        </div>
      </section>
    );
  }

  return (
    <section
      className={joinClassNames(
        'tk-ep-event-description',
        'tk-ep-event-description--inline',
        `tk-ep-align-${alignment}`,
        `tk-ep-section-spacing-${spacing}`,
      )}
      data-block-id={id}
      data-block-type="EventDescription"
      style={sectionStyle}
    >
      {copy}
      {resolvedImageUrl ? (
        <div
          data-hero-image-surface
          className={joinClassNames(
            'tk-ep-inline-image-overlay',
            'tk-ep-event-description__image',
            `tk-ep-align-${imageAlignment}`,
            showCanvasImageEditor ? 'tk-ep-image-surface--editing' : undefined,
          )}
          style={overlaySurfaceStyle}
        >
          <img
            className={`tk-ep-hero__image tk-ep-radius-${imageRadius}`}
            data-event-page-outline-target={`${id}:image`}
            src={resolvedImageUrl}
            alt={resolvedImageAlt}
            loading="lazy"
            style={imageStyle}
          />
          {logoStrip}
          <div data-event-page-outline-target={`${id}:imageOverlay`}>
            {renderImageOverlay(overlayClassName('tk-ep-overlay-slot', overlayContentPosition), 72)}
          </div>
          {canvasImageEditor}
        </div>
      ) : (
        logoStrip
      )}
    </section>
  );
}

export function RichTextBlock({
  id,
  body,
  alignment = 'left',
  textSize = 'normal',
  spacing = 'normal',
  sectionStyle = 'plain',
  fontSize,
  lineHeight,
  paragraphGap,
}: WithBlockId<EventPageRichTextProps>) {
  const bodyContent = body as ReactNode;
  const bodyProps =
    typeof body === 'string'
      ? { dangerouslySetInnerHTML: { __html: sanitizeEventPageHtml(body) } }
      : { children: bodyContent };

  return (
    <section
      className={sectionClassNames('tk-ep-rich-text', { alignment, spacing, sectionStyle }, [
        `tk-ep-text-${textSize}`,
      ])}
      data-block-id={id}
      data-block-type="RichText"
      data-event-page-outline-target={`${id}:body`}
      style={
        {
          ...styleFromLengths({ fontSize, lineHeight }),
          ...(paragraphGap ? { '--tk-ep-rich-text-gap': paragraphGap } : {}),
        } as CSSProperties
      }
      {...bodyProps}
    />
  );
}

export function EventHeaderBlock({
  id,
  brandLabel,
  title,
  description,
  startsAtLabel,
  timezone,
  venueName,
  showDate = true,
  showTimezone = true,
  showVenue = true,
  showBrandBadge = true,
  imageUrl,
  imageAlt,
  imageFit = 'cover',
  imagePosition = 'center',
  imagePositionX,
  imagePositionY,
  imagePlacement,
  overlayContentPosition = 'center',
  overlayContentHorizontalPosition = 'left',
  overlayMinHeight,
  overlayPadding,
  contentPadding,
  contentGap,
  imageOpacity,
  backgroundOverlayColor,
  backgroundOverlayOpacity,
  logos,
  logoPosition = 'top-left',
  logoSize = 'md',
  logoMaxHeight,
  logoMaxWidth,
  titleFontSize,
  titleColor,
  descriptionFontSize,
  descriptionColor,
  metaFontSize,
  metaColor,
  metaIconColor,
  metaGap,
  badgeFontSize,
  badgeTextColor,
  badgeBackgroundColor,
  badgeBorderColor,
  puck,
}: WithBlockId<EventPageEventHeaderProps> & {
  puck?: { isEditing?: boolean };
}) {
  const runtime = useEventPageRuntime();
  const resolvedImage = resolveEventPageImage(imageUrl, imageAlt, runtime);
  const resolvedImageUrl = resolvedImage?.url;
  const resolvedImageAlt = resolvedImage?.altText ?? '';
  const resolvedBrand =
    typeof brandLabel === 'string' || brandLabel == null
      ? trimmedText(brandLabel) || runtime.brandName
      : (brandLabel as ReactNode);
  const resolvedTitle =
    typeof title === 'string' || title == null ? trimmedText(title, 'Event') : title;
  const resolvedDescription =
    typeof description === 'string' || description == null ? trimmedText(description) : description;
  const resolvedStartsAt =
    typeof startsAtLabel === 'string' || startsAtLabel == null
      ? trimmedText(startsAtLabel, 'Date to be announced')
      : startsAtLabel;
  const rawTimezone = typeof timezone === 'string' || timezone == null ? trimmedText(timezone) : '';
  const resolvedTimezone =
    (typeof rawTimezone === 'string' && rawTimezone
      ? (formatTimezoneLabel(rawTimezone) ?? rawTimezone)
      : '') || 'Timezone to be announced';
  const resolvedVenue =
    typeof venueName === 'string' || venueName == null
      ? trimmedText(venueName, 'Venue to be announced')
      : venueName;

  const showCanvasImageEditor = Boolean(
    puck?.isEditing && runtime.interactive === false && Boolean(resolvedImageUrl),
  );
  const resolvedPlacement = resolveHeroImagePlacement({
    imagePlacement,
    imagePosition,
    imagePositionX,
    imagePositionY,
  });
  const imageStyle = {
    objectFit: imageFit,
    objectPosition: resolvedPlacement.objectPosition,
    transform: resolvedPlacement.transform,
    transformOrigin: resolvedPlacement.transformOrigin,
  } satisfies CSSProperties;
  const editorPlacementValue = normalizeHeroImagePlacement({
    x: resolvedPlacement.x,
    y: resolvedPlacement.y,
    scale: resolvedPlacement.scale,
  });
  const canvasImageEditor = showCanvasImageEditor ? (
    <HeroImageCanvasEditor
      id={id}
      blockType="EventHeader"
      imageFit={imageFit ?? 'cover'}
      placement={editorPlacementValue}
    />
  ) : null;
  const logoStrip = renderImageLogoStrip({
    logos,
    logoPosition,
    logoSize,
    logoMaxHeight,
    logoMaxWidth,
    ariaLabel: 'Event header logos',
    extraClassName: 'tk-ep-event-header__logos',
    outlineTargetPrefix: `${id}:Logos`,
  });
  const overlaySurfaceStyle = {
    ...styleFromLengths({
      minHeight: overlayMinHeight,
      padding: overlayPadding,
    }),
    ...(imageOpacity ? { '--tk-ep-image-opacity': imageOpacity } : {}),
    ...(backgroundOverlayColor ? { '--tk-ep-overlay-color': backgroundOverlayColor } : {}),
    ...(backgroundOverlayOpacity ? { '--tk-ep-overlay-opacity': backgroundOverlayOpacity } : {}),
  } as CSSProperties;

  const contentStyle = styleFromLengths({
    padding: contentPadding,
    gap: contentGap,
  });
  const badgeStyle = {
    ...styleFromLengths({ fontSize: badgeFontSize }),
    ...(badgeTextColor ? { color: badgeTextColor } : {}),
    ...(badgeBackgroundColor ? { backgroundColor: badgeBackgroundColor } : {}),
    ...(badgeBorderColor ? { borderColor: badgeBorderColor } : {}),
  } satisfies CSSProperties;
  const titleStyle = {
    ...styleFromLengths({ fontSize: titleFontSize }),
    ...(titleColor ? { color: titleColor } : {}),
  } satisfies CSSProperties;
  const descriptionStyle = {
    ...styleFromLengths({ fontSize: descriptionFontSize }),
    ...(descriptionColor ? { color: descriptionColor } : {}),
  } satisfies CSSProperties;
  const metaStyle = {
    ...styleFromLengths({ fontSize: metaFontSize, gap: metaGap }),
    ...(metaColor ? { color: metaColor } : {}),
  } satisfies CSSProperties;
  const metaIconStyle = metaIconColor
    ? ({ color: metaIconColor } satisfies CSSProperties)
    : undefined;

  const content = (
    <div
      className={joinClassNames(
        'tk-ep-event-header__content',
        `tk-ep-align-${overlayContentHorizontalPosition}`,
      )}
      style={contentStyle}
    >
      {showBrandBadge ? (
        <span
          className="tk-ep-event-header__badge"
          data-event-page-outline-target={`${id}:badge`}
          data-slot="badge"
          style={badgeStyle}
        >
          <TicketIcon className="tk-ep-event-header__icon" />
          {resolvedBrand}
        </span>
      ) : null}
      <h1 data-event-page-outline-target={`${id}:title`} style={titleStyle}>
        {resolvedTitle}
      </h1>
      {resolvedDescription ? (
        <p
          className="tk-ep-event-header__description"
          data-event-page-outline-target={`${id}:description`}
          style={descriptionStyle}
        >
          {resolvedDescription}
        </p>
      ) : null}

      {showDate || showTimezone || showVenue ? (
        <dl
          className="tk-ep-event-header__meta"
          data-event-page-outline-target={`${id}:details`}
          style={metaStyle}
        >
          {showDate ? (
            <div>
              <CalendarIcon
                className="tk-ep-event-header__icon"
                aria-hidden
                style={metaIconStyle}
              />
              <dt>Date</dt>
              <dd>{resolvedStartsAt}</dd>
            </div>
          ) : null}
          {showTimezone ? (
            <div>
              <ClockIcon className="tk-ep-event-header__icon" aria-hidden style={metaIconStyle} />
              <dt>Timezone</dt>
              <dd>{resolvedTimezone}</dd>
            </div>
          ) : null}
          {showVenue ? (
            <div>
              <MapPinIcon className="tk-ep-event-header__icon" aria-hidden style={metaIconStyle} />
              <dt>Location</dt>
              <dd>{resolvedVenue}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );

  return (
    <header
      className={joinClassNames(
        'tk-ep-event-header',
        resolvedImageUrl ? 'tk-ep-event-header--background' : undefined,
      )}
      data-block-id={id}
      data-block-type="EventHeader"
    >
      {resolvedImageUrl ? (
        <div
          data-hero-image-surface
          className={overlayClassName(
            joinClassNames(
              'tk-ep-overlay-surface tk-ep-event-header__overlay',
              showCanvasImageEditor ? 'tk-ep-image-surface--editing' : undefined,
            ),
            overlayContentPosition,
          )}
          style={overlaySurfaceStyle}
        >
          <img
            className="tk-ep-overlay-image"
            data-event-page-outline-target={`${id}:image`}
            src={resolvedImageUrl}
            alt={resolvedImageAlt}
            loading="lazy"
            style={imageStyle}
          />
          {logoStrip}
          <div
            className={joinClassNames(
              'tk-ep-overlay-content',
              `tk-ep-overlay-align-${overlayContentHorizontalPosition}`,
            )}
          >
            {content}
          </div>
          {canvasImageEditor}
        </div>
      ) : (
        <>
          {logoStrip}
          {content}
        </>
      )}
    </header>
  );
}

export function MediaBlock({
  id,
  imageUrl,
  imageAlt,
  caption,
  aspectRatio = 'auto',
  alignment = 'left',
  radius = 'soft',
  width = 'normal',
  spacing = 'normal',
  maxWidth,
  customRadius,
  captionFontSize,
  overlayEnabled = false,
  overlayContentPosition = 'center',
  overlayMinHeight,
  overlayPadding,
  imageOpacity,
  imageOverlay: ImageOverlay,
}: WithBlockId<EventPageMediaProps>) {
  const runtime = useEventPageRuntime();
  const resolvedImage = resolveEventPageImage(imageUrl, imageAlt, runtime);
  if (!resolvedImage) return null;
  const renderImageOverlay = () =>
    typeof ImageOverlay === 'function'
      ? (ImageOverlay as OverlaySlotRender)({
          className: 'tk-ep-overlay-slot',
          minEmptyHeight: 96,
        })
      : null;
  const image = (
    <img
      className={`tk-ep-radius-${radius}`}
      data-event-page-outline-target={`${id}:image`}
      src={resolvedImage.url}
      alt={resolvedImage.altText}
      loading="lazy"
      style={styleFromLengths({ borderRadius: customRadius })}
    />
  );

  return (
    <figure
      className={joinClassNames(
        'tk-ep-media',
        `tk-ep-media--${aspectRatio.replace(':', '-')}`,
        `tk-ep-align-${alignment}`,
        `tk-ep-media-width-${width}`,
        `tk-ep-section-spacing-${spacing}`,
      )}
      data-block-id={id}
      data-block-type="Media"
      style={styleFromLengths({ maxWidth })}
    >
      {overlayEnabled ? (
        <div
          className={overlayClassName(
            'tk-ep-overlay-surface tk-ep-media__overlay',
            overlayContentPosition,
          )}
          style={
            {
              ...styleFromLengths({
                minHeight: overlayMinHeight,
                padding: overlayPadding,
              }),
              ...(imageOpacity ? { '--tk-ep-image-opacity': imageOpacity } : {}),
            } as CSSProperties
          }
        >
          <div className="tk-ep-overlay-image">{image}</div>
          <div
            className="tk-ep-overlay-content"
            data-event-page-outline-target={`${id}:imageOverlay`}
          >
            {renderImageOverlay()}
          </div>
        </div>
      ) : (
        image
      )}
      {caption ? (
        <figcaption
          data-event-page-outline-target={`${id}:caption`}
          style={styleFromLengths({ fontSize: captionFontSize })}
        >
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

export function EventDetailsBlock({
  id,
  title,
  items,
  alignment = 'left',
  spacing = 'normal',
  sectionStyle = 'plain',
  titleFontSize,
  titleColor,
  labelFontSize,
  valueFontSize,
  labelColor,
  valueColor,
}: WithBlockId<EventPageDetailsProps>) {
  return (
    <section
      className={sectionClassNames('tk-ep-details', {
        alignment,
        spacing,
        sectionStyle,
      })}
      data-block-id={id}
      data-block-type="EventDetails"
    >
      <h2
        data-event-page-outline-target={`${id}:title`}
        style={styleFromLengths({ fontSize: titleFontSize, color: titleColor })}
      >
        {title}
      </h2>
      <dl data-event-page-outline-target={`${id}:Details`}>
        {items.map((item, index) => (
          <div
            key={`${item.label}:${item.value}`}
            data-event-page-outline-target={`${id}:Details:${index}`}
          >
            <dt
              style={styleFromLengths({
                fontSize: labelFontSize,
                color: labelColor,
              })}
            >
              {item.label}
            </dt>
            <dd
              style={styleFromLengths({
                fontSize: valueFontSize,
                color: valueColor,
              })}
            >
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ScheduleBlock({
  id,
  title,
  items,
  alignment = 'left',
  spacing = 'normal',
  sectionStyle = 'plain',
  titleFontSize,
  titleColor,
}: WithBlockId<EventPageScheduleProps>) {
  return (
    <section
      className={sectionClassNames('tk-ep-schedule', {
        alignment,
        spacing,
        sectionStyle,
      })}
      data-block-id={id}
      data-block-type="Schedule"
    >
      <h2
        data-event-page-outline-target={`${id}:title`}
        style={styleFromLengths({ fontSize: titleFontSize, color: titleColor })}
      >
        {title}
      </h2>
      <ol data-event-page-outline-target={`${id}:Schedule items`}>
        {items.map((item, index) => (
          <li
            key={`${item.title}:${item.startsAt}:${index}`}
            data-event-page-outline-target={`${id}:Schedule items:${index}`}
          >
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

export function VenueBlock({
  id,
  title,
  venueName,
  address,
  mapUrl,
  alignment = 'left',
  spacing = 'normal',
  sectionStyle = 'plain',
  titleFontSize,
  titleColor,
}: WithBlockId<EventPageVenueProps>) {
  return (
    <section
      className={sectionClassNames('tk-ep-venue', {
        alignment,
        spacing,
        sectionStyle,
      })}
      data-block-id={id}
      data-block-type="Venue"
    >
      <h2
        data-event-page-outline-target={`${id}:title`}
        style={styleFromLengths({ fontSize: titleFontSize, color: titleColor })}
      >
        {title}
      </h2>
      <p className="tk-ep-venue__name" data-event-page-outline-target={`${id}:venue`}>
        {venueName}
      </p>
      {address ? <p data-event-page-outline-target={`${id}:address`}>{address}</p> : null}
      {mapUrl ? (
        <a className="tk-ep-link" data-event-page-outline-target={`${id}:map`} href={mapUrl}>
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
  alignment = 'left',
  spacing = 'normal',
  sectionStyle = 'plain',
  titleFontSize,
  titleColor,
  editorPreview = false,
}: WithBlockId<EventPageFaqProps> & { editorPreview?: boolean }) {
  return (
    <section
      className={sectionClassNames('tk-ep-faq', {
        alignment,
        spacing,
        sectionStyle,
      })}
      data-block-id={id}
      data-block-type="FAQ"
      data-event-page-outline-target={`${id}:Questions`}
    >
      <h2
        data-event-page-outline-target={`${id}:title`}
        style={styleFromLengths({ fontSize: titleFontSize, color: titleColor })}
      >
        {title}
      </h2>
      {items.map((item, index) =>
        editorPreview ? (
          <div
            className="tk-ep-faq__item"
            key={item.question}
            data-event-page-outline-target={`${id}:Questions:${index}`}
          >
            <h3>{item.question}</h3>
            <p>{item.answer}</p>
          </div>
        ) : (
          <details key={item.question} data-event-page-outline-target={`${id}:Questions:${index}`}>
            <summary>{item.question}</summary>
            <p>{item.answer}</p>
          </details>
        ),
      )}
    </section>
  );
}

export function SponsorsBlock({
  id,
  title,
  items,
  alignment = 'left',
  spacing = 'normal',
  sectionStyle = 'plain',
  titleFontSize,
  titleColor,
}: WithBlockId<EventPageSponsorsProps>) {
  return (
    <section
      className={sectionClassNames('tk-ep-sponsors', {
        alignment,
        spacing,
        sectionStyle,
      })}
      data-block-id={id}
      data-block-type="Sponsors"
    >
      <h2
        data-event-page-outline-target={`${id}:title`}
        style={styleFromLengths({ fontSize: titleFontSize, color: titleColor })}
      >
        {title}
      </h2>
      <ul className="tk-ep-logo-list" data-event-page-outline-target={`${id}:Sponsors`}>
        {items.map((item, index) => (
          <li key={item.name} data-event-page-outline-target={`${id}:Sponsors:${index}`}>
            {item.imageUrl ? (
              <img src={item.imageUrl} alt={item.imageAlt ?? item.name} loading="lazy" />
            ) : null}
            {item.url ? <a href={item.url}>{item.name}</a> : <span>{item.name}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SpeakersBlock({
  id,
  title,
  items,
  alignment = 'left',
  spacing = 'normal',
  sectionStyle = 'plain',
  titleFontSize,
  titleColor,
}: WithBlockId<EventPageSpeakersProps>) {
  return (
    <section
      className={sectionClassNames('tk-ep-speakers', {
        alignment,
        spacing,
        sectionStyle,
      })}
      data-block-id={id}
      data-block-type="Speakers"
    >
      <h2
        data-event-page-outline-target={`${id}:title`}
        style={styleFromLengths({ fontSize: titleFontSize, color: titleColor })}
      >
        {title}
      </h2>
      <ul className="tk-ep-person-list" data-event-page-outline-target={`${id}:Speakers`}>
        {items.map((item, index) => (
          <li key={item.name} data-event-page-outline-target={`${id}:Speakers:${index}`}>
            {item.imageUrl ? (
              <img src={item.imageUrl} alt={item.imageAlt ?? item.name} loading="lazy" />
            ) : null}
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
  size = 'medium',
  width = 'auto',
  radius = 'soft',
  textStyle = 'normal',
  backgroundColor,
  textColor,
  borderColor,
  openInNewTab = false,
  fontSize,
  paddingX,
  paddingY,
  minHeight,
  borderWidth,
  customRadius,
  letterSpacing,
  lineHeight,
}: WithBlockId<EventPageButtonProps>) {
  return (
    <section
      className={`tk-ep-button-row tk-ep-align-${alignment}`}
      data-block-id={id}
      data-block-type="Button"
    >
      <a
        className={joinClassNames(
          'tk-ep-button',
          `tk-ep-button--${style}`,
          `tk-ep-button--${size}`,
          `tk-ep-button-width-${width}`,
          `tk-ep-button-radius-${radius}`,
          `tk-ep-button-text-${textStyle}`,
        )}
        href={url}
        data-event-page-outline-target={`${id}:label`}
        target={openInNewTab ? '_blank' : undefined}
        rel={openInNewTab ? 'noreferrer' : undefined}
        style={{
          ...styleFromLengths({
            fontSize,
            paddingInline: paddingX,
            paddingBlock: paddingY,
            minHeight,
            borderWidth,
            borderRadius: customRadius,
            letterSpacing,
            lineHeight,
          }),
          ...(backgroundColor ? { backgroundColor } : {}),
          ...(textColor ? { color: textColor } : {}),
          ...(borderColor ? { borderColor } : {}),
        }}
      >
        {label}
      </a>
    </section>
  );
}

export function DividerBlock({ id, spacing = 'normal' }: WithBlockId<EventPageDividerProps>) {
  return (
    <div data-block-id={id} data-block-type="Divider">
      <hr aria-label="Divider" className={`tk-ep-divider tk-ep-divider--${spacing}`} />
    </div>
  );
}

export function SocialLinksBlock({
  id,
  title,
  links,
  alignment = 'left',
  spacing = 'normal',
  sectionStyle = 'plain',
  titleFontSize,
  titleColor,
}: WithBlockId<EventPageSocialLinksProps>) {
  return (
    <section
      className={sectionClassNames('tk-ep-social-links', {
        alignment,
        spacing,
        sectionStyle,
      })}
      data-block-id={id}
      data-block-type="SocialLinks"
    >
      {title ? (
        <h2
          data-event-page-outline-target={`${id}:title`}
          style={styleFromLengths({
            fontSize: titleFontSize,
            color: titleColor,
          })}
        >
          {title}
        </h2>
      ) : null}
      <ul data-event-page-outline-target={`${id}:Links`}>
        {links.map((link, index) => (
          <li
            key={`${link.label}:${link.url}`}
            data-event-page-outline-target={`${id}:Links:${index}`}
          >
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
      data-block-type="CustomEmbed"
      data-event-page-outline-target={`${id}:embed`}
      dangerouslySetInnerHTML={{ __html: sanitizeEventPageEmbedHtml(html) }}
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
  return eventPageBrandVariablesToCssProperties(brandVariables) as CSSProperties &
    Record<string, string>;
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
    'props' in (value as { root: Record<string, unknown> }).root &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export {
  BrandFooterBlock,
  CheckoutCtaBlock,
  EventPageRuntimeProvider,
  ProductAddOnsBlock,
  PublicEventPageSurface,
  ResaleTicketsBlock,
  TicketsBlock,
  formatEventPageMoney,
  ticketPriceLabel,
  useEventPageRuntime,
} from './public-surface.js';
export type {
  EventPageRuntime,
  PublicEventPageChrome,
  PublicEventPageFooterLink,
  PublicEventPageProduct,
  PublicEventPageResaleListing,
  PublicEventPageSurfaceProps,
  PublicEventPageTicket,
} from './public-surface.js';

function isPuckData(value: unknown): value is EventPagePuckData {
  return isEventPagePuckData(value);
}

function joinClassNames(...classNames: Array<string | undefined>): string {
  return classNames.filter(Boolean).join(' ');
}

function safeInlineText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function formatScheduleRange(startsAt: unknown, endsAt?: unknown): string {
  const safeStartsAt = safeInlineText(startsAt);
  const safeEndsAt = safeInlineText(endsAt);
  if (!safeStartsAt && !safeEndsAt) return '';
  if (!safeEndsAt) return safeStartsAt;
  return `${safeStartsAt} - ${safeEndsAt}`;
}
