import {
  EMBED_MODES as CORE_EMBED_MODES,
  EMBED_THEMES as CORE_EMBED_THEMES,
  generateCspProfile,
  generateEmbed as generateCoreEmbed,
  generateEmbedSnippet as generateCoreEmbedSnippet,
  generatePlatformInstructions as generateCorePlatformInstructions,
  validateEmbedOptions as validateCoreEmbedOptions,
  type EmbedGeneratorOptions as CoreEmbedGeneratorOptions,
  type EmbedMode,
  type EmbedTheme,
} from '@tixkit/embed-core';

export type { EmbedMode, EmbedTheme } from '@tixkit/embed-core';
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
  accessCode?: string;
  checkoutBaseUrl?: string;
  reportingApiUrl?: string;
  widgetScriptUrl?: string;
  widgetIntegrity?: string;
  allowedOrigin?: string;
  platform: EmbedPlatform;
  includeLifecycle?: boolean;
  lifecycleCallbackName?: string;
}

export const EMBED_MODES: EmbedMode[] = [...CORE_EMBED_MODES];
export const EMBED_THEMES: EmbedTheme[] = [...CORE_EMBED_THEMES];
export const EMBED_PLATFORMS: EmbedPlatform[] = ['webflow', 'framer', 'plain'];

const DEFAULT_WIDGET_SCRIPT = 'https://cdn.tixkit.com/widget/v1.0.0/tixkit-widget-1.0.0.js';
const DEFAULT_WIDGET_INTEGRITY =
  'sha384-dekV7a3DQg8bDdculs4uy24zS9CiyMfb4QpROp1Pb878LK63cHRC212CsRjzESAB';

function toCoreOptions(options: EmbedGeneratorOptions): CoreEmbedGeneratorOptions {
  return {
    ...options,
    platform: options.platform === 'plain' ? 'html' : options.platform,
    widgetScriptUrl: options.widgetScriptUrl ?? DEFAULT_WIDGET_SCRIPT,
    widgetIntegrity: options.widgetIntegrity ?? DEFAULT_WIDGET_INTEGRITY,
    hostOrigin: options.allowedOrigin,
  };
}

function legacyValidationMessage(path: string, message: string): string {
  const prefixes: Record<string, string> = {
    eventId: 'Invalid event ID',
    brandId: 'Invalid brand ID',
    mode: 'Invalid mode',
    theme: 'Invalid theme',
    hostOrigin: 'Invalid allowed origin',
    checkoutBaseUrl: 'Invalid checkout base URL',
    widgetScriptUrl: 'Invalid widget script URL',
  };
  return `${prefixes[path] ?? `Invalid ${path}`}: ${message}`;
}

export function validateEmbedOptions(options: EmbedGeneratorOptions): string[] {
  return validateCoreEmbedOptions(toCoreOptions(options)).map((issue) =>
    legacyValidationMessage(issue.path, issue.message),
  );
}

export function generateEmbedSnippet(options: EmbedGeneratorOptions): string {
  const errors = validateEmbedOptions(options);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return generateCoreEmbedSnippet(toCoreOptions(options));
}

export function generateCspGuidance(options: EmbedGeneratorOptions): string {
  const profile = generateCspProfile({
    checkoutBaseUrl: options.checkoutBaseUrl,
    widgetScriptUrl: options.widgetScriptUrl ?? DEFAULT_WIDGET_SCRIPT,
    reportingApiUrl: options.reportingApiUrl,
  });
  return `Content-Security-Policy:\n  ${profile.header}`;
}

export function generatePlatformInstructions(platform: EmbedPlatform): string {
  const corePlatform = platform === 'plain' ? 'html' : platform;
  const label = platform === 'plain' ? 'Plain HTML' : platform === 'webflow' ? 'Webflow' : 'Framer';
  return `${label} placement:\n${generateCorePlatformInstructions(corePlatform)}`;
}

export interface EmbedGeneratorResult {
  ok: boolean;
  snippet: string;
  cspGuidance: string;
  instructions: string;
  message: string;
}

export function generateEmbed(options: EmbedGeneratorOptions): EmbedGeneratorResult {
  const coreOptions = toCoreOptions(options);
  const result = generateCoreEmbed(coreOptions);
  if (!result.ok) {
    return {
      ok: false,
      snippet: '',
      cspGuidance: '',
      instructions: '',
      message: result.errors
        .map((issue) => legacyValidationMessage(issue.path, issue.message))
        .join('\n'),
    };
  }
  return {
    ok: true,
    snippet: result.snippet,
    cspGuidance: `Content-Security-Policy:\n  ${result.csp.header}`,
    instructions: generatePlatformInstructions(options.platform),
    message: 'Embed snippet generated successfully.',
  };
}
