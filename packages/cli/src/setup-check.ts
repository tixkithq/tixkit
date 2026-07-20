import { readFile } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { parseEnvFile, isPlaceholderValue } from './env.js';

export type ValidationMode = 'local' | 'provider' | 'production';

export type ValidationIssue = {
  variable: string;
  severity: 'error' | 'warning';
  mode: ValidationMode | 'all';
  message: string;
  guide?: string;
};

export type ValidationResult = {
  ok: boolean;
  mode: ValidationMode;
  filePath: string;
  issues: ValidationIssue[];
};

export type EnvRule = {
  variable: string;
  requiredFor: ValidationMode[];
  message: string;
  guide?: string;
  validate?: (value: string) => string | undefined;
};

const GUIDES = {
  clerk: 'docs/public/self-hosting/authentication.mdx',
  webhook: 'docs/public/developers/webhooks/setup.mdx',
  dev: 'docs/public/getting-started/local-quickstart.mdx',
  deploy: 'docs/public/self-hosting/deployment.mdx',
  stripe: 'docs/public/reference/api/index.mdx',
} as const;

export const ENV_RULES: EnvRule[] = [
  {
    variable: 'NODE_ENV',
    requiredFor: ['local', 'provider', 'production'],
    message: 'Must be set to development, test, or production.',
    validate: (value) => {
      const ok = ['development', 'test', 'production'].includes(value);
      return ok ? undefined : 'expected one of development, test, or production';
    },
  },
  {
    variable: 'PORT',
    requiredFor: ['local', 'provider', 'production'],
    message: 'API port is required for the API server to bind.',
    validate: (value) => {
      const num = Number(value);
      return Number.isInteger(num) && num > 0 && num <= 65535
        ? undefined
        : 'expected a valid TCP port';
    },
  },
  {
    variable: 'DATABASE_URL',
    requiredFor: ['local', 'provider', 'production'],
    message: 'PostgreSQL connection string is required for the reference database.',
    validate: (value) => {
      if (!value.startsWith('postgres://') && !value.startsWith('postgresql://')) {
        return 'expected a postgres:// or postgresql:// connection string';
      }
      return undefined;
    },
  },
  {
    variable: 'DATABASE_URL_MYSQL',
    requiredFor: ['local', 'provider', 'production'],
    message: 'MySQL connection string is required for Tier 1 parity testing.',
    validate: (value) => {
      return value.startsWith('mysql://') ? undefined : 'expected a mysql:// connection string';
    },
  },
  {
    variable: 'REDIS_URL',
    requiredFor: ['local', 'provider', 'production'],
    message:
      'Redis URL is required for rate limits, export SSE fanout, and short-lived coordination.',
    validate: (value) => {
      return value.startsWith('redis://') || value.startsWith('rediss://')
        ? undefined
        : 'expected a redis:// or rediss:// URL';
    },
  },
  {
    variable: 'TEMPORAL_ADDRESS',
    requiredFor: ['local', 'provider', 'production'],
    message: 'Temporal server address is required for durable workflows.',
  },
  {
    variable: 'TEMPORAL_NAMESPACE',
    requiredFor: ['local', 'provider', 'production'],
    message: 'Temporal namespace is required.',
  },
  {
    variable: 'S3_ENDPOINT',
    requiredFor: ['local', 'provider', 'production'],
    message: 'S3-compatible storage endpoint is required for uploads and exports.',
  },
  {
    variable: 'S3_BUCKET',
    requiredFor: ['local', 'provider', 'production'],
    message: 'S3 bucket name is required for uploads and exports.',
  },
  {
    variable: 'S3_ACCESS_KEY_ID',
    requiredFor: ['local', 'provider', 'production'],
    message: 'S3 access key is required for uploads and exports.',
  },
  {
    variable: 'S3_SECRET_ACCESS_KEY',
    requiredFor: ['local', 'provider', 'production'],
    message: 'S3 secret key is required for uploads and exports.',
  },
  {
    variable: 'API_BASE_URL',
    requiredFor: ['local', 'provider', 'production'],
    message: 'API base URL is required for self-referencing URLs and webhooks.',
  },
  {
    variable: 'NEXT_PUBLIC_TIXKIT_API_BASE_URL',
    requiredFor: ['local', 'provider', 'production'],
    message: 'Public API base URL is required for checkout and admin clients.',
  },
  {
    variable: 'NEXT_PUBLIC_ADMIN_API_BASE_URL',
    requiredFor: ['local', 'provider', 'production'],
    message: 'Admin API base URL is required for the admin dashboard.',
  },
  {
    variable: 'QR_SIGNING_SECRET',
    requiredFor: ['production'],
    message:
      'QR signing secret is required in production to produce verifiable ticket QR payloads.',
    guide: GUIDES.deploy,
  },
  {
    variable: 'OFFLINE_MANIFEST_SIGNING_KEY',
    requiredFor: ['production'],
    message:
      'Offline manifest signing key is required in production for scanner manifest verification.',
    guide: GUIDES.deploy,
  },
  {
    variable: 'OFFLINE_MANIFEST_KEY_ID',
    requiredFor: ['production'],
    message: 'Offline manifest key ID is required in production.',
  },
  {
    variable: 'OFFLINE_MANIFEST_ACTIVE_KEY_ID',
    requiredFor: ['production'],
    message: 'An active ES256 offline manifest key ID is required in production.',
    guide: GUIDES.deploy,
  },
  {
    variable: 'OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON',
    requiredFor: ['production'],
    message: 'A versioned P-256 offline manifest private-key registry is required in production.',
    guide: GUIDES.deploy,
  },
  {
    variable: 'WIDGET_IMPRESSION_HASH_SECRET',
    requiredFor: ['production'],
    message: 'Widget impression hash secret is required in production to pseudonymize visitor IDs.',
    guide: GUIDES.deploy,
  },
  {
    variable: 'DASHBOARD_CURSOR_SIGNING_KEY',
    requiredFor: ['production'],
    message:
      'Dashboard cursor signing key is required in production to bind paginated actions to one scope and snapshot.',
    guide: GUIDES.deploy,
  },
  {
    variable: 'CLERK_SECRET_KEY',
    requiredFor: ['production'],
    message:
      'Clerk secret key is required in production; local development may leave it empty for the dev principal.',
    guide: GUIDES.clerk,
  },
  {
    variable: 'CLERK_PUBLISHABLE_KEY',
    requiredFor: ['production'],
    message: 'Clerk publishable key is required in production.',
    guide: GUIDES.clerk,
  },
  {
    variable: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
    requiredFor: ['production'],
    message: 'Public Clerk publishable key is required in production.',
    guide: GUIDES.clerk,
  },
  {
    variable: 'CLERK_WEBHOOK_SECRET',
    requiredFor: ['production'],
    message: 'Clerk webhook secret is required in production to verify Clerk webhook signatures.',
    guide: GUIDES.clerk,
  },
  {
    variable: 'STRIPE_SECRET_KEY',
    requiredFor: ['provider', 'production'],
    message:
      'Stripe secret key is required for real provider payments; omit only for local capture-mode testing.',
  },
  {
    variable: 'STRIPE_WEBHOOK_SECRET',
    requiredFor: ['provider', 'production'],
    message: 'Stripe webhook secret is required for real Stripe webhook verification.',
    guide: GUIDES.webhook,
  },
  {
    variable: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
    requiredFor: ['provider', 'production'],
    message: 'Stripe publishable key is required for real Stripe Elements in checkout.',
  },
  {
    variable: 'STRIPE_CONNECT_CLIENT_ID',
    requiredFor: [],
    message: 'Stripe Connect client ID is required for Stripe Connect onboarding.',
  },
  {
    variable: 'TELNYX_API_KEY',
    requiredFor: [],
    message: 'Telnyx API key is required for SMS delivery; optional otherwise.',
  },
  {
    variable: 'TELNYX_WEBHOOK_PUBLIC_KEY',
    requiredFor: [],
    message: 'Telnyx webhook public key is required to verify Telnyx SMS webhooks.',
  },
  {
    variable: 'EMAIL_WEBHOOK_SECRET',
    requiredFor: ['production'],
    message:
      'Email webhook secret is required in production to verify bounce/complaint/failure feedback.',
    guide: GUIDES.webhook,
  },
  {
    variable: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    requiredFor: ['local', 'provider', 'production'],
    message:
      'OpenTelemetry collector endpoint is required for local observability; set OTEL_SDK_DISABLED=true only for focused debugging.',
  },
];

export function getModeFromEnv(entries: Map<string, string>): ValidationMode {
  const nodeEnv = entries.get('NODE_ENV') ?? 'development';
  if (nodeEnv === 'production') return 'production';

  const hasStripe = !isPlaceholderValue(entries.get('STRIPE_SECRET_KEY') ?? '');
  const hasClerk = !isPlaceholderValue(entries.get('CLERK_SECRET_KEY') ?? '');
  const hasTelnyx = !isPlaceholderValue(entries.get('TELNYX_API_KEY') ?? '');

  if (hasStripe || hasClerk || hasTelnyx) return 'provider';
  return 'local';
}

export async function validateEnvFile(
  filePath: string,
  mode?: ValidationMode,
): Promise<ValidationResult> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      mode: mode ?? 'local',
      filePath,
      issues: [
        {
          variable: 'FILE',
          severity: 'error',
          mode: 'all',
          message: `Cannot read environment file: ${detail}`,
          guide: GUIDES.dev,
        },
      ],
    };
  }

  const parsed = parseEnvFile(content);
  const detectedMode = mode ?? getModeFromEnv(parsed.entries);
  const issues: ValidationIssue[] = [];

  for (const rule of ENV_RULES) {
    if (!rule.requiredFor.includes(detectedMode)) continue;

    const rawValue = parsed.entries.get(rule.variable);
    const isMissing = rawValue === undefined || isPlaceholderValue(rawValue);

    if (isMissing) {
      issues.push({
        variable: rule.variable,
        severity: 'error',
        mode: detectedMode,
        message: rule.message,
        guide: rule.guide,
      });
      continue;
    }

    if (rule.validate) {
      const validationError = rule.validate(rawValue);
      if (validationError) {
        issues.push({
          variable: rule.variable,
          severity: 'error',
          mode: detectedMode,
          message: `${rule.message} (${validationError})`,
          guide: rule.guide,
        });
      }
    }
  }

  const incidentEnabled = parsed.entries.get('PROVIDER_INCIDENT_SINK_ENABLED')?.toLowerCase();
  if (incidentEnabled !== undefined && !['true', 'false'].includes(incidentEnabled)) {
    issues.push({
      variable: 'PROVIDER_INCIDENT_SINK_ENABLED',
      severity: 'error',
      mode: detectedMode,
      message: 'Provider incident evidence must be explicitly true or false.',
      guide: GUIDES.deploy,
    });
  }
  if (incidentEnabled === 'true') {
    const requiredIncidentValues = [
      'PROVIDER_INCIDENT_CAPTURE_UNTIL',
      'PROVIDER_INCIDENT_RETENTION_MINUTES',
      'PROVIDER_INCIDENT_MAX_ACTIVE_PER_TENANT',
      'PROVIDER_INCIDENT_ACTIVE_KEY_ID',
      'PROVIDER_INCIDENT_KEYRING_JSON',
    ];
    for (const variable of requiredIncidentValues) {
      if (isPlaceholderValue(parsed.entries.get(variable) ?? '')) {
        issues.push({
          variable,
          severity: 'error',
          mode: detectedMode,
          message: `${variable} is required when provider incident evidence is enabled.`,
          guide: GUIDES.deploy,
        });
      }
    }
    const retention = Number(parsed.entries.get('PROVIDER_INCIDENT_RETENTION_MINUTES'));
    if (!Number.isSafeInteger(retention) || retention < 1 || retention > 1440) {
      issues.push({
        variable: 'PROVIDER_INCIDENT_RETENTION_MINUTES',
        severity: 'error',
        mode: detectedMode,
        message: 'Provider incident retention must be an integer from 1 through 1440 minutes.',
        guide: GUIDES.deploy,
      });
    }
    const maximum = Number(parsed.entries.get('PROVIDER_INCIDENT_MAX_ACTIVE_PER_TENANT'));
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) {
      issues.push({
        variable: 'PROVIDER_INCIDENT_MAX_ACTIVE_PER_TENANT',
        severity: 'error',
        mode: detectedMode,
        message: 'Provider incident active evidence cap must be an integer from 1 through 1000.',
        guide: GUIDES.deploy,
      });
    }
    const captureUntil = Date.parse(parsed.entries.get('PROVIDER_INCIDENT_CAPTURE_UNTIL') ?? '');
    if (!Number.isFinite(captureUntil) || captureUntil > Date.now() + 24 * 60 * 60 * 1_000) {
      issues.push({
        variable: 'PROVIDER_INCIDENT_CAPTURE_UNTIL',
        severity: 'error',
        mode: detectedMode,
        message: 'Provider incident capture window must be valid and at most 24 hours ahead.',
        guide: GUIDES.deploy,
      });
    }
    try {
      const keyring = JSON.parse(parsed.entries.get('PROVIDER_INCIDENT_KEYRING_JSON') ?? '');
      const activeKeyId = parsed.entries.get('PROVIDER_INCIDENT_ACTIVE_KEY_ID') ?? '';
      const keyIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
      if (
        !keyring ||
        typeof keyring !== 'object' ||
        Array.isArray(keyring) ||
        Object.keys(keyring).length === 0 ||
        !keyIdPattern.test(activeKeyId) ||
        Buffer.byteLength(activeKeyId, 'utf8') > 64 ||
        !Object.hasOwn(keyring, activeKeyId)
      ) {
        throw new Error('invalid keyring');
      }
      for (const [keyId, encoded] of Object.entries(keyring)) {
        if (
          !keyIdPattern.test(keyId) ||
          Buffer.byteLength(keyId, 'utf8') > 64 ||
          typeof encoded !== 'string'
        ) {
          throw new Error('invalid keyring entry');
        }
        const key = Buffer.from(encoded, 'base64');
        if (key.byteLength !== 32 || key.toString('base64') !== encoded)
          throw new Error('invalid key');
      }
    } catch {
      issues.push({
        variable: 'PROVIDER_INCIDENT_KEYRING_JSON',
        severity: 'error',
        mode: detectedMode,
        message:
          'Provider incident keyring must contain only valid key IDs and canonical base64 32-byte keys, including the active key.',
        guide: GUIDES.deploy,
      });
    }
  }

  const manifestRegistryRaw = parsed.entries.get('OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON');
  const manifestActiveKeyId = parsed.entries.get('OFFLINE_MANIFEST_ACTIVE_KEY_ID') ?? '';
  if (manifestRegistryRaw && !isPlaceholderValue(manifestRegistryRaw)) {
    try {
      const registry = JSON.parse(manifestRegistryRaw) as unknown;
      if (
        !Array.isArray(registry) ||
        registry.length === 0 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(manifestActiveKeyId) ||
        !registry.some(
          (entry) =>
            entry !== null &&
            typeof entry === 'object' &&
            (entry as Record<string, unknown>).keyId === manifestActiveKeyId,
        )
      ) {
        throw new Error('invalid registry');
      }
      const keyIds = new Set<string>();
      for (const rawEntry of registry) {
        if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
          throw new Error('invalid key');
        }
        const entry = rawEntry as Record<string, unknown>;
        if (
          typeof entry.keyId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(entry.keyId) ||
          keyIds.has(entry.keyId) ||
          typeof entry.privateKeyPem !== 'string' ||
          typeof entry.notBefore !== 'string' ||
          typeof entry.notAfter !== 'string'
        ) {
          throw new Error('invalid key fields');
        }
        keyIds.add(entry.keyId);
        const notBefore = Date.parse(entry.notBefore);
        const notAfter = Date.parse(entry.notAfter);
        if (
          !Number.isFinite(notBefore) ||
          !Number.isFinite(notAfter) ||
          new Date(notBefore).toISOString() !== entry.notBefore ||
          new Date(notAfter).toISOString() !== entry.notAfter ||
          notAfter <= notBefore ||
          createPrivateKey(entry.privateKeyPem).asymmetricKeyDetails?.namedCurve !== 'prime256v1'
        ) {
          throw new Error('invalid key material');
        }
        if (
          entry.keyId === manifestActiveKeyId &&
          (notBefore > Date.now() || notAfter < Date.now() + 24 * 60 * 60 * 1000)
        ) {
          throw new Error('active key window');
        }
      }
    } catch {
      issues.push({
        variable: 'OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON',
        severity: 'error',
        mode: detectedMode,
        message:
          'Offline manifest V2 keys must be unique P-256 private keys with canonical validity windows, including an active key valid for at least 24 hours.',
        guide: GUIDES.deploy,
      });
    }
  }

  // Warn when signing secrets are present but look like placeholders in non-production modes.
  for (const secretVar of [
    'QR_SIGNING_SECRET',
    'OFFLINE_MANIFEST_SIGNING_KEY',
    'OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON',
  ]) {
    const value = parsed.entries.get(secretVar);
    if (value !== undefined && isPlaceholderValue(value)) {
      issues.push({
        variable: secretVar,
        severity: 'warning',
        mode: detectedMode,
        message: `${secretVar} looks like a placeholder; generate a real secret before production.`,
        guide: GUIDES.deploy,
      });
    }
  }

  const hasErrors = issues.some((issue) => issue.severity === 'error');

  return {
    ok: !hasErrors,
    mode: detectedMode,
    filePath,
    issues,
  };
}

export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push(`setup:check passed for ${result.mode} mode (${result.filePath}).`);
  } else {
    lines.push(`setup:check failed for ${result.mode} mode (${result.filePath}).`);
  }

  for (const issue of result.issues) {
    const severity = issue.severity === 'error' ? 'error' : 'warning';
    const guide = issue.guide ? ` [see ${issue.guide}]` : '';
    lines.push(`  [${severity}] ${issue.variable}: ${issue.message}${guide}`);
  }

  return lines.join('\n');
}
