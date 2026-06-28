export type EmbedMode = 'inline' | 'modal' | 'button' | 'redirect';
export type EmbedTheme = 'auto' | 'light' | 'dark';
export type EmbedPlatform = 'webflow' | 'framer' | 'plain';

export interface EmbedGeneratorOptions {
  eventId: string;
  brandId: string;
  mode: EmbedMode;
  theme?: EmbedTheme;
  locale?: string;
  trackingId?: string;
  products?: string;
  items?: string;
  discountCode?: string;
  checkoutBaseUrl?: string;
  widgetScriptUrl?: string;
  allowedOrigin?: string;
  platform: EmbedPlatform;
  includeLifecycle?: boolean;
  lifecycleCallbackName?: string;
}

export const EMBED_MODES: EmbedMode[] = ['inline', 'modal', 'button', 'redirect'];
export const EMBED_THEMES: EmbedTheme[] = ['auto', 'light', 'dark'];
export const EMBED_PLATFORMS: EmbedPlatform[] = ['webflow', 'framer', 'plain'];

const VALID_EVENT_ID = /^[a-zA-Z0-9_-]+$/;
const VALID_BRAND_ID = /^[a-zA-Z0-9_-]+$/;
const VALID_ORIGIN = /^https?:\/\/[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(:\d+)?$/;

const DEFAULT_WIDGET_SCRIPT = 'https://cdn.tixkit.com/widget/tixkit-widget.js';
const DEFAULT_CHECKOUT_URL = 'https://checkout.tixkit.com';

export function validateEmbedOptions(options: EmbedGeneratorOptions): string[] {
  const errors: string[] = [];

  if (!options.eventId || !VALID_EVENT_ID.test(options.eventId)) {
    errors.push('Invalid event ID: use alphanumeric characters, hyphens, and underscores only.');
  }
  if (!options.brandId || !VALID_BRAND_ID.test(options.brandId)) {
    errors.push('Invalid brand ID: use alphanumeric characters, hyphens, and underscores only.');
  }
  if (!EMBED_MODES.includes(options.mode)) {
    errors.push(`Invalid mode: must be one of ${EMBED_MODES.join(', ')}.`);
  }
  if (options.theme && !EMBED_THEMES.includes(options.theme)) {
    errors.push(`Invalid theme: must be one of ${EMBED_THEMES.join(', ')}.`);
  }
  if (options.allowedOrigin && !VALID_ORIGIN.test(options.allowedOrigin)) {
    errors.push('Invalid allowed origin: must be an http(s) URL like https://yoursite.com.');
  }
  if (options.checkoutBaseUrl && !VALID_ORIGIN.test(options.checkoutBaseUrl)) {
    errors.push('Invalid checkout base URL: must be an http(s) URL.');
  }
  if (options.widgetScriptUrl && !VALID_ORIGIN.test(options.widgetScriptUrl)) {
    errors.push('Invalid widget script URL: must be an http(s) URL.');
  }

  return errors;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildElementAttributes(options: EmbedGeneratorOptions): string {
  const attrs: string[] = [
    `brand="${escapeHtml(options.brandId)}"`,
    `event="${escapeHtml(options.eventId)}"`,
  ];

  const checkoutMode = options.mode === 'button' ? 'modal' : options.mode;
  attrs.push(`checkout-mode="${escapeHtml(checkoutMode)}"`);

  if (options.theme && options.theme !== 'auto') {
    attrs.push(`theme="${escapeHtml(options.theme)}"`);
  }
  if (options.locale) {
    attrs.push(`locale="${escapeHtml(options.locale)}"`);
  }
  if (options.trackingId) {
    attrs.push(`tracking-id="${escapeHtml(options.trackingId)}"`);
  }
  if (options.products) {
    attrs.push(`products="${escapeHtml(options.products)}"`);
  }
  if (options.items) {
    attrs.push(`items="${escapeHtml(options.items)}"`);
  }
  if (options.discountCode) {
    attrs.push(`discount-code="${escapeHtml(options.discountCode)}"`);
  }

  const checkoutUrl = options.checkoutBaseUrl ?? DEFAULT_CHECKOUT_URL;
  attrs.push(`api-base-url="${escapeHtml(checkoutUrl)}"`);

  return attrs.join('\n  ');
}

export function generateEmbedSnippet(options: EmbedGeneratorOptions): string {
  const errors = validateEmbedOptions(options);
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  const scriptUrl = options.widgetScriptUrl ?? DEFAULT_WIDGET_SCRIPT;
  const attrs = buildElementAttributes(options);
  const useButton = options.mode === 'button';
  const tagName = useButton ? 'tixkit-button' : 'tixkit-widget';
  const elementId = `tixkit-${options.mode}-${options.eventId}`;

  let snippet = `<!-- Tixkit embed: ${escapeHtml(options.platform)} -->\n`;
  snippet += `<script type="module" src="${escapeHtml(scriptUrl)}"></script>\n\n`;
  snippet += `<${tagName} id="${elementId}"\n  ${attrs}`;
  if (useButton) {
    snippet += `>\n  Buy tickets\n</${tagName}>`;
  } else {
    snippet += `></${tagName}>`;
  }

  if (options.includeLifecycle) {
    const cbName = options.lifecycleCallbackName ?? 'onTixkitEvent';
    snippet += '\n\n<script type="module">\n';
    snippet += `  const el = document.getElementById('${elementId}');\n`;
    snippet += `  function ${cbName}(name, detail) {\n`;
    snippet += '    console.log(\'Tixkit:\', name, detail);\n';
    snippet += '    // Handle: loaded, opened, closed, checkout_started, order_completed, error\n';
    snippet += '  }\n';
    snippet += '  for (const name of [\'loaded\', \'opened\', \'closed\', \'checkout_started\', \'order_completed\', \'error\']) {\n';
    snippet += '    el.addEventListener(name, (e) => ';
    snippet += `${cbName}(name, e.detail));\n`;
    snippet += '  }\n';
    snippet += '</script>';
  }

  return snippet;
}

export function generateCspGuidance(options: EmbedGeneratorOptions): string {
  const checkoutUrl = options.checkoutBaseUrl ?? DEFAULT_CHECKOUT_URL;
  const scriptUrl = options.widgetScriptUrl ?? DEFAULT_WIDGET_SCRIPT;
  const scriptOrigin = new URL(scriptUrl).origin;
  const checkoutOrigin = new URL(checkoutUrl).origin;

  return [
    'Content-Security-Policy:',
    `  default-src 'self';`,
    `  script-src 'self' ${scriptOrigin} https://www.googletagmanager.com https://connect.facebook.net;`,
    `  frame-src ${checkoutOrigin};`,
    `  child-src ${checkoutOrigin};`,
    `  connect-src 'self' ${checkoutOrigin} https:;`,
    `  style-src 'self' 'unsafe-inline';`,
    `  img-src 'self' data: https:;`,
  ].join('\n');
}

export function generatePlatformInstructions(platform: EmbedPlatform): string {
  switch (platform) {
    case 'webflow':
      return [
        'Webflow placement:',
        '1. Open your Webflow project in the Designer.',
        '2. Go to Project Settings > Custom Code > Footer Code.',
        '3. Paste the <script> tag from the snippet above.',
        '4. Add an Embed component (or HTML embed widget) where you want the widget.',
        '5. Paste the <tixkit-widget> or <tixkit-button> element inside the Embed.',
        '6. If you included lifecycle events, paste the <script> block in the same Embed.',
        '7. Publish your site.',
      ].join('\n');
    case 'framer':
      return [
        'Framer placement:',
        '1. Open your Framer project.',
        '2. Insert a Code Component or use the Embed element.',
        '3. Paste the entire snippet (script + element + optional lifecycle script).',
        '4. Alternatively, add the <script> tag in Site Settings > Code > End of body.',
        '5. Place the <tixkit-widget> or <tixkit-button> in an Embed layer on the canvas.',
        '6. Publish or preview your site.',
      ].join('\n');
    default:
      return [
        'Plain HTML placement:',
        '1. Add the <script> tag in the <head> or before the closing </body> tag.',
        '2. Place the <tixkit-widget> or <tixkit-button> element where you want it.',
        '3. If you included lifecycle events, add the <script> block after the element.',
      ].join('\n');
  }
}

export interface EmbedGeneratorResult {
  ok: boolean;
  snippet: string;
  cspGuidance: string;
  instructions: string;
  message: string;
}

export function generateEmbed(options: EmbedGeneratorOptions): EmbedGeneratorResult {
  try {
    const snippet = generateEmbedSnippet(options);
    const cspGuidance = generateCspGuidance(options);
    const instructions = generatePlatformInstructions(options.platform);
    return {
      ok: true,
      snippet,
      cspGuidance,
      instructions,
      message: 'Embed snippet generated successfully.',
    };
  } catch (err) {
    return {
      ok: false,
      snippet: '',
      cspGuidance: '',
      instructions: '',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
