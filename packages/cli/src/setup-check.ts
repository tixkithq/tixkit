import { readFile } from 'node:fs/promises';
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
  clerk: 'docs/clerk-setup-guide.md',
  webhook: 'docs/webhook-guide.md',
  dev: 'docs/completion/dev-resources.md',
  deploy: 'docs/production-deployment-guide.md',
  stripe: 'docs/api-reference.md',
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

  // Warn when signing secrets are present but look like placeholders in non-production modes.
  for (const secretVar of ['QR_SIGNING_SECRET', 'OFFLINE_MANIFEST_SIGNING_KEY']) {
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
