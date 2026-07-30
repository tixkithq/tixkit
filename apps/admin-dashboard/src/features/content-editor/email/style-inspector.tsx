'use client';

import * as React from 'react';
import { Inspector } from '@react-email/editor/ui';
import type { InspectorNodeContext } from '@react-email/editor/ui';

export type EmailThemePreset = 'brand' | 'minimal' | 'basic';

export type StyleInspectorProps = {
  onUploadImage?: (file: File) => Promise<{ url: string }>;
};

const inspectorNodeSectionLayout: Record<string, string[]> = {
  image: ['attributes', 'size', 'link', 'padding', 'background', 'border'],
  button: ['link', 'size', 'padding', 'border', 'background'],
  section: ['background', 'padding', 'border'],
  div: ['background', 'padding', 'border'],
  codeBlock: ['attributes', 'padding', 'border'],
  footer: ['padding', 'background'],
  twoColumns: ['columnSpacing', 'padding', 'background', 'border'],
  threeColumns: ['columnSpacing', 'padding', 'background', 'border'],
  fourColumns: ['columnSpacing', 'padding', 'background', 'border'],
};
const inspectorDefaultSections = ['padding', 'background', 'border'];

function inspectorSectionTypesForNode(nodeType: string): string[] {
  return inspectorNodeSectionLayout[nodeType] ?? inspectorDefaultSections;
}

function parseInlineStyle(value: unknown): Map<string, string> {
  const properties = new Map<string, string>();
  if (typeof value !== 'string') return properties;
  for (const declaration of value.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const propertyValue = declaration.slice(separator + 1).trim();
    if (property && propertyValue) properties.set(property, propertyValue);
  }
  return properties;
}

function serializeInlineStyle(properties: Map<string, string>): string {
  return [...properties.entries()].map(([property, value]) => `${property}: ${value}`).join('; ');
}

function backgroundImageUrl(value: string | undefined): string | undefined {
  const match = value?.match(/url\((?:["']?)(.*?)(?:["']?)\)\s*$/i);
  return match?.[1]?.replace(/["']$/, '').trim() || undefined;
}

function overlayOpacity(value: string | undefined): number {
  const match = value?.match(/rgba?\([^)]*,\s*(0(?:\.\d+)?|1(?:\.0+)?)\)/i);
  const parsed = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 48;
}

function cssPosition(value: string | undefined): { x: number; y: number } {
  const match = value?.match(/(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%/);
  return {
    x: match ? Math.max(0, Math.min(100, Number(match[1]))) : 50,
    y: match ? Math.max(0, Math.min(100, Number(match[2]))) : 50,
  };
}

function HeroBackgroundControls({
  context,
  onUploadImage,
}: {
  context: InspectorNodeContext;
  onUploadImage?: StyleInspectorProps['onUploadImage'];
}) {
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string>();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const style = parseInlineStyle(context.getAttr('style'));
  const imageUrl = backgroundImageUrl(style.get('background-image'));
  const opacity = overlayOpacity(style.get('background-image'));
  const position = cssPosition(style.get('background-position'));
  const fit = style.get('background-size') === 'contain' ? 'contain' : 'cover';
  const minHeight = Number.parseInt(style.get('min-height') ?? '320', 10) || 320;
  const textColor = style.get('color') ?? '#ffffff';

  function updateStyle(updates: Record<string, string | undefined>) {
    const next = parseInlineStyle(context.getAttr('style'));
    for (const [property, value] of Object.entries(updates)) {
      if (value) next.set(property, value);
      else next.delete(property);
    }
    context.setAttr('style', serializeInlineStyle(next));
  }

  function setBackground(url: string | undefined, nextOpacity = opacity) {
    if (!url) {
      updateStyle({
        'background-image': undefined,
        'background-position': undefined,
        'background-repeat': undefined,
        'background-size': undefined,
      });
      return;
    }
    const alpha = Math.max(0, Math.min(100, nextOpacity)) / 100;
    updateStyle({
      'background-image': `linear-gradient(rgba(6, 35, 63, ${alpha}), rgba(6, 35, 63, ${alpha})), url("${url.replace(/["\\]/g, '')}")`,
      'background-position': `${position.x}% ${position.y}%`,
      'background-repeat': 'no-repeat',
      'background-size': fit,
    });
  }

  async function upload(file: File | undefined) {
    if (!file || !onUploadImage) return;
    setUploading(true);
    setUploadError(undefined);
    try {
      const result = await onUploadImage(file);
      setBackground(result.url);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Unable to upload background image.');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <section className="space-y-4 border-b pb-5" data-testid="hero-background-controls">
      <div>
        <p className="text-sm font-semibold text-foreground">Hero background</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Place text and your brand logo over a focal image with a readable color overlay.
        </p>
      </div>
      <div className="flex gap-2">
        <label className="relative flex-1 cursor-pointer overflow-hidden rounded-md border bg-background px-3 py-2 text-center text-xs font-medium hover:bg-muted has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
          <span>{uploading ? 'Uploading…' : imageUrl ? 'Replace image' : 'Upload image'}</span>
          <input
            accept="image/jpeg,image/png,image/webp,image/gif"
            aria-label={imageUrl ? 'Replace hero background image' : 'Upload hero background image'}
            className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
            disabled={!onUploadImage || uploading}
            onChange={(event) => void upload(event.target.files?.[0])}
            ref={inputRef}
            type="file"
          />
        </label>
        {imageUrl ? (
          <button
            aria-label="Remove hero background image"
            className="rounded-md border px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10"
            onClick={() => setBackground(undefined)}
            type="button"
          >
            Remove
          </button>
        ) : null}
      </div>
      {uploadError ? <p className="text-xs text-destructive">{uploadError}</p> : null}
      {imageUrl ? (
        <>
          <label className="block space-y-1.5 text-xs font-medium">
            <span>Image fit</span>
            <select
              className="h-9 w-full rounded-md border bg-background px-2"
              onChange={(event) => updateStyle({ 'background-size': event.target.value })}
              value={fit}
            >
              <option value="cover">Fill hero (cover)</option>
              <option value="contain">Show full image (contain)</option>
            </select>
          </label>
          <label className="block space-y-1.5 text-xs font-medium">
            <span>Horizontal focus · {position.x}%</span>
            <input
              className="w-full accent-primary"
              max="100"
              min="0"
              onChange={(event) =>
                updateStyle({ 'background-position': `${event.target.value}% ${position.y}%` })
              }
              type="range"
              value={position.x}
            />
          </label>
          <label className="block space-y-1.5 text-xs font-medium">
            <span>Vertical focus · {position.y}%</span>
            <input
              className="w-full accent-primary"
              max="100"
              min="0"
              onChange={(event) =>
                updateStyle({ 'background-position': `${position.x}% ${event.target.value}%` })
              }
              type="range"
              value={position.y}
            />
          </label>
          <label className="block space-y-1.5 text-xs font-medium">
            <span>Overlay · {opacity}%</span>
            <input
              className="w-full accent-primary"
              max="90"
              min="0"
              onChange={(event) => setBackground(imageUrl, Number(event.target.value))}
              type="range"
              value={opacity}
            />
          </label>
        </>
      ) : null}
      <label className="block space-y-1.5 text-xs font-medium">
        <span>Minimum height · {minHeight}px</span>
        <input
          className="w-full accent-primary"
          max="640"
          min="180"
          onChange={(event) => updateStyle({ 'min-height': `${event.target.value}px` })}
          step="10"
          type="range"
          value={minHeight}
        />
      </label>
      <label className="flex items-center justify-between text-xs font-medium">
        <span>Text color</span>
        <input
          aria-label="Hero text color"
          className="h-9 w-14 rounded border bg-background p-1"
          onChange={(event) => updateStyle({ color: event.target.value })}
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(textColor) ? textColor : '#ffffff'}
        />
      </label>
    </section>
  );
}

function ImageAlignmentControls({ context }: { context: InspectorNodeContext }) {
  const alignment =
    context.getAttr('alignment') === 'left' || context.getAttr('alignment') === 'right'
      ? String(context.getAttr('alignment'))
      : 'center';
  return (
    <section className="space-y-3 border-b pb-5" data-testid="image-alignment-controls">
      <div>
        <p className="text-sm font-semibold text-foreground">Alignment</p>
        <p className="mt-1 text-xs text-muted-foreground">Position this image in the email row.</p>
      </div>
      <fieldset
        aria-label="Image alignment"
        className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1"
      >
        {(['left', 'center', 'right'] as const).map((value) => (
          <button
            aria-pressed={alignment === value}
            className={
              alignment === value
                ? 'rounded bg-background px-2 py-1.5 text-xs font-medium shadow-sm'
                : 'rounded px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground'
            }
            key={value}
            onClick={() => context.setAttr('alignment', value)}
            type="button"
          >
            {value[0]!.toUpperCase() + value.slice(1)}
          </button>
        ))}
      </fieldset>
    </section>
  );
}

function labelNativeInspectorControls(root: HTMLElement) {
  const controls = root.querySelectorAll<HTMLElement>(
    '[data-re-inspector-color-trigger], [data-re-inspector-color-hex], [data-re-inspector-input]',
  );
  for (const control of controls) {
    if (control.getAttribute('aria-label') || control.getAttribute('aria-labelledby')) continue;
    const row = control.closest<HTMLElement>('[data-re-inspector-prop-row]');
    const section = row?.closest<HTMLElement>('[data-re-inspector-section]');
    const sectionLabel = section
      ?.querySelector<HTMLElement>('[data-re-inspector-section-header] [data-re-inspector-text]')
      ?.textContent?.trim();
    const propertyLabel = row
      ?.querySelector<HTMLElement>('[data-re-inspector-label]')
      ?.textContent?.trim();
    const controlLabel = control.hasAttribute('data-re-inspector-color-trigger')
      ? 'picker'
      : control.hasAttribute('data-re-inspector-color-hex')
        ? 'hex value'
        : 'value';
    control.setAttribute(
      'aria-label',
      [sectionLabel, propertyLabel, controlLabel].filter(Boolean).join(' ') ||
        'Style inspector value',
    );
  }
}

export function StyleInspector({ onUploadImage }: StyleInspectorProps) {
  const inspectorRef = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    const inspector = inspectorRef.current;
    if (!inspector) return;
    labelNativeInspectorControls(inspector);
    const observer = new MutationObserver(() => labelNativeInspectorControls(inspector));
    observer.observe(inspector, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <aside
      aria-label="Email style inspector"
      className="fixed bottom-0 right-0 top-[60px] z-30 hidden w-80 shrink-0 border-l bg-background text-foreground shadow-xl lg:flex xl:w-[22rem]"
      data-testid="native-email-inspector-host"
      data-tixkit-email-inspector="true"
      ref={inspectorRef}
    >
      <Inspector.Root aria-label="React Email style inspector" className="flex min-h-0 flex-1">
        <div className="tixkit-email-native-inspector flex min-h-0 flex-1 flex-col">
          <div className="border-b px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Page style</p>
            <div className="mt-1 text-sm font-semibold text-foreground">
              <Inspector.Breadcrumb />
            </div>
          </div>
          <div
            className="min-h-0 flex-1 overflow-auto px-5 py-5 pr-6"
            style={{ scrollbarGutter: 'stable' }}
          >
            <div className="space-y-5">
              <Inspector.Document />
              <Inspector.Node>
                {(context) => {
                  const sectionTypes = inspectorSectionTypesForNode(context.nodeType);
                  return (
                    <>
                      {context.nodeType === 'section' ? (
                        <HeroBackgroundControls context={context} onUploadImage={onUploadImage} />
                      ) : null}
                      {context.nodeType === 'image' ? (
                        <ImageAlignmentControls context={context} />
                      ) : null}
                      {sectionTypes.map((type) => {
                        switch (type) {
                          case 'attributes':
                            return <Inspector.Attributes key={type} {...context} />;
                          case 'size':
                            return <Inspector.Size key={type} {...context} />;
                          case 'padding':
                            return <Inspector.Padding key={type} {...context} />;
                          case 'columnSpacing':
                            return <Inspector.ColumnSpacing key={type} {...context} />;
                          case 'background':
                            return <Inspector.Background key={type} {...context} />;
                          case 'border':
                            return <Inspector.Border key={type} {...context} />;
                          default:
                            return null;
                        }
                      })}
                    </>
                  );
                }}
              </Inspector.Node>
            </div>
          </div>
        </div>
      </Inspector.Root>
    </aside>
  );
}
