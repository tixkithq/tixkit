import { createHash, createSign, randomBytes } from 'node:crypto';
import { PKPass } from 'passkit-generator';

export type WalletPassProvider = 'apple' | 'google';

export type WalletPassTicketInput = {
  passId: string;
  ticketId: string;
  ticketCode: string;
  ticketTypeName: string;
  attendeeName: string;
  qrPayload: string;
  eventId: string;
  eventTitle: string;
  startsAt: Date | string;
  timezone: string;
  venueName?: string;
  brandName: string;
  brandColor?: string;
};

export type WalletPassArtifact = {
  provider: WalletPassProvider;
  serialNumber: string;
  passUrl: string;
  accessToken?: string;
  accessTokenHash?: string;
  contentType?: string;
  artifactBase64?: string;
  metadata: Record<string, unknown>;
};

export type AppleWalletConfig = {
  passTypeIdentifier: string;
  teamIdentifier: string;
  organizationName: string;
  signerCert: string;
  signerKey: string;
  signerKeyPassphrase?: string;
  wwdr: string;
};

export type GoogleWalletConfig = {
  issuerId: string;
  classSuffix: string;
  serviceAccountEmail: string;
  privateKey: string;
  origins: string[];
};

export type WalletPassConfig = {
  apiBaseUrl: string;
  apple?: AppleWalletConfig;
  google?: GoogleWalletConfig;
};

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZq2GQAAAABJRU5ErkJggg==',
  'base64',
);

function hasAny(env: NodeJS.ProcessEnv, keys: string[]): boolean {
  return keys.some((key) => typeof env[key] === 'string' && env[key]!.trim().length > 0);
}

function required(env: NodeJS.ProcessEnv, keys: string[]): string[] {
  return keys.filter((key) => !env[key] || env[key]!.trim().length === 0);
}

function normalizePem(value: string): string {
  return value.replaceAll('\\n', '\n');
}

function normalizeApiV1BaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function sanitizeGoogleSuffix(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

function localized(value: string) {
  return {
    defaultValue: {
      language: 'en-US',
      value,
    },
  };
}

function rgbString(hex?: string): string {
  if (!hex || !/^#[\dA-Fa-f]{6}$/.test(hex)) return 'rgb(21, 24, 31)';
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `rgb(${red}, ${green}, ${blue})`;
}

function formatPassDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function signJwt(claims: Record<string, unknown>, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .end()
    .sign(normalizePem(privateKey))
    .toString('base64url');
  return `${signingInput}.${signature}`;
}

export function loadWalletPassConfig(env: NodeJS.ProcessEnv = process.env): WalletPassConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const apiBaseUrl = normalizeApiV1BaseUrl(env.API_BASE_URL ?? 'http://localhost:4000');

  const appleKeys = [
    'APPLE_WALLET_PASS_TYPE_ID',
    'APPLE_WALLET_TEAM_ID',
    'APPLE_WALLET_SIGNER_CERT',
    'APPLE_WALLET_SIGNER_KEY',
    'APPLE_WALLET_WWDR_CERT',
  ];
  const googleKeys = [
    'GOOGLE_WALLET_ISSUER_ID',
    'GOOGLE_WALLET_CLASS_SUFFIX',
    'GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_WALLET_PRIVATE_KEY',
    'GOOGLE_WALLET_ORIGIN',
  ];

  const appleRequested =
    env.APPLE_WALLET_ENABLED === 'true' ||
    (nodeEnv === 'production' && env.APPLE_WALLET_ENABLED !== 'false') ||
    hasAny(env, appleKeys);
  const googleRequested =
    env.GOOGLE_WALLET_ENABLED === 'true' ||
    (nodeEnv === 'production' && env.GOOGLE_WALLET_ENABLED !== 'false') ||
    hasAny(env, googleKeys);

  const missingApple = appleRequested ? required(env, appleKeys) : [];
  const missingGoogle = googleRequested ? required(env, googleKeys) : [];
  const missing = [...missingApple, ...missingGoogle];
  if (missing.length > 0) {
    throw new Error(`Wallet pass signing configuration is incomplete: ${missing.join(', ')}`);
  }

  return {
    apiBaseUrl,
    apple: appleRequested
      ? {
          passTypeIdentifier: env.APPLE_WALLET_PASS_TYPE_ID!,
          teamIdentifier: env.APPLE_WALLET_TEAM_ID!,
          organizationName:
            env.APPLE_WALLET_ORGANIZATION_NAME ?? env.GOOGLE_WALLET_ISSUER_NAME ?? 'Tixkit',
          signerCert: normalizePem(env.APPLE_WALLET_SIGNER_CERT!),
          signerKey: normalizePem(env.APPLE_WALLET_SIGNER_KEY!),
          signerKeyPassphrase: env.APPLE_WALLET_SIGNER_KEY_PASSPHRASE,
          wwdr: normalizePem(env.APPLE_WALLET_WWDR_CERT!),
        }
      : undefined,
    google: googleRequested
      ? {
          issuerId: env.GOOGLE_WALLET_ISSUER_ID!,
          classSuffix: sanitizeGoogleSuffix(env.GOOGLE_WALLET_CLASS_SUFFIX!),
          serviceAccountEmail: env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL!,
          privateKey: normalizePem(env.GOOGLE_WALLET_PRIVATE_KEY!),
          origins: env
            .GOOGLE_WALLET_ORIGIN!.split(',')
            .map((origin) => origin.trim())
            .filter(Boolean),
        }
      : undefined,
  };
}

export function createAppleWalletPass(
  input: WalletPassTicketInput,
  config: AppleWalletConfig,
): PKPass {
  const pass = new PKPass(
    {
      'icon.png': ONE_PIXEL_PNG,
      'icon@2x.png': ONE_PIXEL_PNG,
    },
    {
      signerCert: config.signerCert,
      signerKey: config.signerKey,
      signerKeyPassphrase: config.signerKeyPassphrase,
      wwdr: config.wwdr,
    },
    {
      description: `${input.eventTitle} ticket`,
      formatVersion: 1,
      organizationName: config.organizationName,
      passTypeIdentifier: config.passTypeIdentifier,
      serialNumber: input.ticketId,
      teamIdentifier: config.teamIdentifier,
      foregroundColor: 'rgb(255, 255, 255)',
      labelColor: 'rgb(235, 238, 245)',
      backgroundColor: rgbString(input.brandColor),
    },
  );

  pass.type = 'eventTicket';
  pass.headerFields.push({ key: 'ticket', label: 'TICKET', value: input.ticketTypeName });
  pass.primaryFields.push({ key: 'event', label: 'EVENT', value: input.eventTitle });
  pass.secondaryFields.push(
    { key: 'date', label: 'DATE', value: formatPassDate(input.startsAt) },
    { key: 'venue', label: 'VENUE', value: input.venueName ?? 'Venue TBA' },
  );
  pass.auxiliaryFields.push(
    { key: 'holder', label: 'ATTENDEE', value: input.attendeeName },
    { key: 'code', label: 'CODE', value: input.ticketCode },
  );
  pass.backFields.push(
    { key: 'ticketId', label: 'Ticket ID', value: input.ticketId },
    { key: 'timezone', label: 'Timezone', value: input.timezone },
  );
  pass.setBarcodes({
    message: input.qrPayload,
    format: 'PKBarcodeFormatQR',
    messageEncoding: 'iso-8859-1',
    altText: input.ticketCode,
  });
  return pass;
}

export async function generateAppleWalletPass(
  input: WalletPassTicketInput,
  config: AppleWalletConfig,
  apiBaseUrl: string,
): Promise<WalletPassArtifact> {
  const accessToken = randomBytes(32).toString('base64url');
  const accessTokenHash = await cryptoHash(accessToken);
  const pass = createAppleWalletPass(input, config);
  const passBuffer = pass.getAsBuffer();

  return {
    provider: 'apple',
    serialNumber: input.ticketId,
    passUrl: `${apiBaseUrl}/wallet-passes/${encodeURIComponent(input.passId)}/apple.pkpass?token=${encodeURIComponent(accessToken)}`,
    accessToken,
    accessTokenHash,
    contentType: 'application/vnd.apple.pkpass',
    artifactBase64: passBuffer.toString('base64'),
    metadata: {
      passTypeIdentifier: config.passTypeIdentifier,
      teamIdentifier: config.teamIdentifier,
      barcodeFormat: 'PKBarcodeFormatQR',
      barcodeMessage: input.qrPayload,
    },
  };
}

export function generateGoogleWalletPass(
  input: WalletPassTicketInput,
  config: GoogleWalletConfig,
): WalletPassArtifact {
  const classId = `${config.issuerId}.${config.classSuffix}`;
  const objectId = `${config.issuerId}.${sanitizeGoogleSuffix(input.ticketId)}`;
  const eventTicketClass = {
    id: classId,
    issuerName: input.brandName,
    reviewStatus: 'UNDER_REVIEW',
    eventName: localized(input.eventTitle),
  };
  const eventTicketObject = {
    id: objectId,
    classId,
    state: 'ACTIVE',
    ticketHolderName: input.attendeeName,
    ticketNumber: input.ticketCode,
    barcode: {
      type: 'QR_CODE',
      value: input.qrPayload,
      alternateText: input.ticketCode,
    },
    eventName: localized(input.eventTitle),
    venue: input.venueName ? localized(input.venueName) : undefined,
    dateTime: {
      start: formatPassDate(input.startsAt),
    },
    hexBackgroundColor: input.brandColor,
  };
  const claims = {
    iss: config.serviceAccountEmail,
    aud: 'google',
    origins: config.origins,
    typ: 'savetowallet',
    payload: {
      eventTicketClasses: [eventTicketClass],
      eventTicketObjects: [eventTicketObject],
    },
  };
  const jwt = signJwt(claims, config.privateKey);

  return {
    provider: 'google',
    serialNumber: objectId,
    passUrl: `https://pay.google.com/gp/v/save/${jwt}`,
    metadata: {
      classId,
      objectId,
      barcodeType: 'QR_CODE',
      barcodeValue: input.qrPayload,
    },
  };
}

export async function generateWalletPassesForTicket(
  input: WalletPassTicketInput,
  config: WalletPassConfig,
): Promise<WalletPassArtifact[]> {
  const artifacts: WalletPassArtifact[] = [];
  if (config.apple) {
    artifacts.push(await generateAppleWalletPass(input, config.apple, config.apiBaseUrl));
  }
  if (config.google) {
    artifacts.push(generateGoogleWalletPass(input, config.google));
  }
  return artifacts;
}

async function cryptoHash(value: string): Promise<string> {
  return createHash('sha256').update(value).digest('hex');
}
