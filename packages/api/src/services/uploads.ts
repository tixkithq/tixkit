import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Socket } from 'node:net';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ulid } from 'ulid';
import sharp from 'sharp';
import { s3PutEncryption } from './s3-encryption.js';
import {
  MIGRATION_IMPORT_INITIAL_RETENTION_MS,
  MIGRATION_IMPORT_MAX_BYTES,
  MIGRATION_IMPORT_MAX_RETENTION_MS,
  MIGRATION_IMPORT_PREPARATION_LEASE_MS,
  type Database,
} from '@tixkit/db';
import { ValidationError, NotFoundError } from '@tixkit/domain';
import { config } from '../config/index.js';

export type UploadPurpose =
  | 'checkout_answer'
  | 'brand_logo'
  | 'user_avatar'
  | 'content_email_image'
  | 'content_event_page_image'
  | 'migration_import'
  | 'event_cover'
  | 'event_poster'
  | 'event_social'
  | 'event_seo_image';

export type CreateUploadInput = {
  tenantId: string;
  organizationId?: string | null;
  brandId?: string | null;
  eventId?: string | null;
  createdByUserId?: string | null;
  purpose: UploadPurpose;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  metadata?: Record<string, unknown>;
  publicComplete?: boolean;
};

export type UploadArtifactResponse = {
  artifactId: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  completeUrl: string;
  completeToken?: string;
  expiresAt: string;
};

const EICAR_SIGNATURE = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const UPLOAD_TTL_SECONDS = 15 * 60;
const UPLOAD_SCANNER_UNAVAILABLE_MESSAGE = 'Upload malware scanner is unavailable';
const CLAMAV_DEFAULT_PORT = 3310;
const CLAMAV_DEFAULT_TIMEOUT_MS = 10_000;
const CLAMAV_MIN_TIMEOUT_MS = 50;
const CLAMAV_MAX_TIMEOUT_MS = 30_000;
const CLAMAV_MAX_RESPONSE_BYTES = 4 * 1024;
export { MIGRATION_IMPORT_MAX_BYTES };
export const MIGRATION_IMPORT_RETENTION_MS = MIGRATION_IMPORT_INITIAL_RETENTION_MS;
const MIGRATION_IMPORT_ACTIVE_RENEWAL_MS = MIGRATION_IMPORT_PREPARATION_LEASE_MS;
const MIGRATION_IMPORT_ACTIVE_JOB_STATUSES = new Set([
  'preparing',
  'discovering',
  'extracting',
  'normalizing',
  'validating',
  'committing',
  'cancelling',
  'rolling-back',
]);

const PURPOSE_LIMITS: Record<
  UploadPurpose,
  { maxSizeBytes: number; contentTypes: Set<string>; prefix: string }
> = {
  checkout_answer: {
    maxSizeBytes: 10 * 1024 * 1024,
    contentTypes: new Set([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'text/plain',
    ]),
    prefix: 'checkout-answers',
  },
  brand_logo: {
    maxSizeBytes: 2 * 1024 * 1024,
    contentTypes: new Set(['image/jpeg', 'image/png', 'image/webp']),
    prefix: 'brand-logos',
  },
  user_avatar: {
    maxSizeBytes: 2 * 1024 * 1024,
    contentTypes: new Set(['image/jpeg', 'image/png', 'image/webp']),
    prefix: 'avatars',
  },
  content_email_image: {
    maxSizeBytes: 5 * 1024 * 1024,
    contentTypes: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
    prefix: 'content-email-images',
  },
  content_event_page_image: {
    maxSizeBytes: 5 * 1024 * 1024,
    contentTypes: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
    prefix: 'content-event-page-images',
  },
  migration_import: {
    maxSizeBytes: MIGRATION_IMPORT_MAX_BYTES,
    contentTypes: new Set([
      'application/json',
      'application/vnd.tixkit.portable+json',
      'application/zip',
      'text/csv',
      'text/plain',
    ]),
    prefix: 'migration-imports',
  },
  event_cover: {
    maxSizeBytes: 8 * 1024 * 1024,
    contentTypes: new Set(['image/jpeg', 'image/png', 'image/webp']),
    prefix: 'event-covers',
  },
  event_poster: {
    maxSizeBytes: 12 * 1024 * 1024,
    contentTypes: new Set(['image/jpeg', 'image/png', 'image/webp']),
    prefix: 'event-posters',
  },
  event_social: {
    maxSizeBytes: 8 * 1024 * 1024,
    contentTypes: new Set(['image/jpeg', 'image/png', 'image/webp']),
    prefix: 'event-social',
  },
  event_seo_image: {
    maxSizeBytes: 8 * 1024 * 1024,
    contentTypes: new Set(['image/jpeg', 'image/png', 'image/webp']),
    prefix: 'event-seo-images',
  },
};

function isUploadPurpose(value: string): value is UploadPurpose {
  return Object.hasOwn(PURPOSE_LIMITS, value);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function uploadTokenMatches(expectedHash: string | null, token: string): boolean {
  if (!expectedHash) return false;
  const expected = Buffer.from(expectedHash, 'hex');
  const candidate = Buffer.from(tokenHash(token), 'hex');
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

function safeFileName(name: string): string {
  const trimmed = name
    .trim()
    .replaceAll(/[/\\]/g, '-')
    .replaceAll(/[^\w .@-]/g, '_');
  return trimmed.length > 0 ? trimmed.slice(0, 180) : 'upload';
}

function extension(name: string): string {
  const match = /\.[A-Za-z0-9]{1,12}$/.exec(name);
  return match ? match[0].toLowerCase() : '';
}

function assertUploadAllowed(
  input: Pick<CreateUploadInput, 'purpose' | 'contentType' | 'sizeBytes'>,
): void {
  if (!isUploadPurpose(input.purpose)) {
    throw new ValidationError(`Unsupported upload purpose: ${input.purpose}`);
  }
  const limits = PURPOSE_LIMITS[input.purpose];
  if (!limits.contentTypes.has(input.contentType)) {
    throw new ValidationError(`Unsupported upload content type: ${input.contentType}`);
  }
  if (
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes <= 0 ||
    input.sizeBytes > limits.maxSizeBytes
  ) {
    throw new ValidationError(`Upload exceeds ${limits.maxSizeBytes} byte limit`);
  }
}

const IMAGE_MAGIC_BYTES: Record<string, (buf: Buffer) => boolean> = {
  'image/jpeg': (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  'image/png': (buf) =>
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a,
  'image/webp': (buf) =>
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50,
  'image/gif': (buf) =>
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61,
};

function validateImageSignature(contentType: string, buffer: Buffer): void {
  const checker = IMAGE_MAGIC_BYTES[contentType];
  if (!checker) return;
  if (!checker(buffer)) {
    throw new ValidationError(
      `Uploaded image content does not match declared content type: ${contentType}`,
    );
  }
}

const IMAGE_FORMAT_BY_CONTENT_TYPE = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
} as const;
const GENERIC_IMAGE_MAX_TOTAL_PIXELS = 40_000_000;
const GENERIC_IMAGE_MAX_PAGES = 20;
const PNG_CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function pngCrc32(buffer: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1)
    crc = PNG_CRC32_TABLE[(crc ^ buffer[offset]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function assertPngStructure(buffer: Buffer): void {
  let offset = 8;
  let chunkIndex = 0;
  let sawHeader = false;
  let sawImageData = false;
  let imageDataEnded = false;
  let sawEnd = false;
  while (offset < buffer.length) {
    if (buffer.length - offset < 12)
      throw new ValidationError('Uploaded PNG contains a truncated chunk');
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (
      !Number.isSafeInteger(dataEnd) ||
      dataEnd < dataStart ||
      chunkEnd < dataEnd ||
      chunkEnd > buffer.length
    )
      throw new ValidationError('Uploaded PNG chunk length is invalid');
    const type = buffer.toString('ascii', typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/.test(type))
      throw new ValidationError('Uploaded PNG chunk type is invalid');
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    if (pngCrc32(buffer, typeStart, dataEnd) !== expectedCrc)
      throw new ValidationError('Uploaded PNG chunk checksum is invalid');

    if (chunkIndex === 0 && (type !== 'IHDR' || length !== 13))
      throw new ValidationError('Uploaded PNG must begin with one 13-byte IHDR chunk');
    if (type === 'IHDR') {
      if (sawHeader || chunkIndex !== 0 || length !== 13)
        throw new ValidationError('Uploaded PNG IHDR chunk is duplicated or invalid');
      sawHeader = true;
    } else if (!sawHeader) {
      throw new ValidationError('Uploaded PNG is missing its IHDR chunk');
    }
    if (type === 'IDAT') {
      if (imageDataEnded) throw new ValidationError('Uploaded PNG IDAT chunks are not consecutive');
      sawImageData = true;
    } else if (sawImageData && type !== 'IEND') {
      imageDataEnded = true;
    }
    if (type === 'IEND') {
      if (sawEnd || length !== 0 || !sawImageData || chunkEnd !== buffer.length)
        throw new ValidationError('Uploaded PNG IEND chunk is premature, duplicated, or invalid');
      sawEnd = true;
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  if (!sawHeader || !sawImageData || !sawEnd)
    throw new ValidationError('Uploaded PNG is missing required structural chunks');
}

function assertJpegStructure(buffer: Buffer): void {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8)
    throw new ValidationError(
      'Uploaded image content does not match declared content type: image/jpeg',
    );
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  let inEntropy = false;
  while (offset < buffer.length) {
    if (!inEntropy && buffer[offset] !== 0xff)
      throw new ValidationError('Uploaded JPEG contains malformed marker boundaries');
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const markerStart = offset;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length)
      throw new ValidationError('Uploaded image is truncated or contains trailing data');
    const marker = buffer[offset]!;
    offset += 1;
    if (inEntropy) {
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      inEntropy = false;
      offset = markerStart;
      continue;
    }
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan || offset !== buffer.length)
        throw new ValidationError('Uploaded image is truncated or contains trailing data');
      return;
    }
    if (marker === 0xd8 || marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
      throw new ValidationError('Uploaded JPEG contains an invalid standalone marker');
    if (offset + 2 > buffer.length)
      throw new ValidationError('Uploaded image is truncated or contains trailing data');
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length)
      throw new ValidationError('Uploaded JPEG contains an invalid marker length');
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    )
      sawFrame = true;
    offset += segmentLength;
    if (marker === 0xda) {
      sawScan = true;
      inEntropy = true;
    }
  }
  throw new ValidationError('Uploaded image is truncated or contains trailing data');
}

function assertImageContainerEndsAtBufferBoundary(contentType: string, buffer: Buffer): void {
  if (contentType === 'image/jpeg') {
    assertJpegStructure(buffer);
    return;
  }
  if (contentType === 'image/png') {
    assertPngStructure(buffer);
    return;
  }
  if (contentType === 'image/webp') {
    const declaredLength = buffer.length >= 8 ? buffer.readUInt32LE(4) + 8 : 0;
    if (declaredLength !== buffer.length)
      throw new ValidationError('Uploaded image is truncated or contains trailing data');
    return;
  }
  if (contentType === 'image/gif' && buffer.at(-1) !== 0x3b)
    throw new ValidationError('Uploaded image is truncated or contains trailing data');
}

async function inspectFullyDecodedImage(
  contentType: string,
  buffer: Buffer,
  policy: { maxPages: number; maxTotalPixels: number },
): Promise<{ width: number; height: number; format: 'jpeg' | 'png' | 'webp' | 'gif' }> {
  validateImageSignature(contentType, buffer);
  assertImageContainerEndsAtBufferBoundary(contentType, buffer);
  const expectedFormat =
    IMAGE_FORMAT_BY_CONTENT_TYPE[contentType as keyof typeof IMAGE_FORMAT_BY_CONTENT_TYPE];
  if (!expectedFormat) throw new ValidationError(`Unsupported image content type: ${contentType}`);

  try {
    const image = sharp(buffer, {
      animated: true,
      failOn: 'warning',
      limitInputPixels: policy.maxTotalPixels,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    const pages = metadata.pages ?? 1;
    const pageHeight = metadata.pageHeight ?? metadata.height;
    if (
      metadata.format !== expectedFormat ||
      !metadata.width ||
      !metadata.height ||
      !pageHeight ||
      pages < 1 ||
      pages > policy.maxPages ||
      !Number.isSafeInteger(metadata.width) ||
      !Number.isSafeInteger(pageHeight) ||
      metadata.width * pageHeight * pages > policy.maxTotalPixels
    ) {
      throw new ValidationError('Uploaded image dimensions, frames, or format are unsupported');
    }

    // Metadata parsing alone can accept signature-only or truncated inputs. Decoding every
    // selected page proves the immutable original is renderable while preserving its bytes.
    const decoded = await image.clone().raw().toBuffer({ resolveWithObject: true });
    if (
      decoded.data.length === 0 ||
      decoded.info.width !== metadata.width ||
      decoded.info.height !== pageHeight * pages
    ) {
      throw new ValidationError('Uploaded image could not be decoded completely');
    }
    return {
      width: metadata.width,
      height: pageHeight,
      format: expectedFormat,
    };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('Uploaded image is malformed or exceeds decode limits');
  }
}

async function sanitizeGenericImage(contentType: string, buffer: Buffer): Promise<Buffer> {
  try {
    const input = sharp(buffer, {
      animated: true,
      failOn: 'warning',
      limitInputPixels: GENERIC_IMAGE_MAX_TOTAL_PIXELS,
      sequentialRead: true,
    }).autoOrient();
    switch (contentType) {
      case 'image/jpeg':
        return await input.jpeg().toBuffer();
      case 'image/png':
        return await input.png().toBuffer();
      case 'image/webp':
        return await input.webp().toBuffer();
      case 'image/gif':
        return await input.gif().toBuffer();
      default:
        throw new ValidationError(`Unsupported image content type: ${contentType}`);
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('Uploaded image could not be sanitized safely');
  }
}

const EVENT_MEDIA_PURPOSES: ReadonlySet<UploadPurpose> = new Set([
  'event_cover',
  'event_poster',
  'event_social',
  'event_seo_image',
]);
const EVENT_MEDIA_MAX_INPUT_PIXELS = 40_000_000;

async function inspectEventMediaImage(
  contentType: string,
  buffer: Buffer,
): Promise<{
  width: number;
  height: number;
  format: 'jpeg' | 'png' | 'webp';
}> {
  const metadata = await inspectFullyDecodedImage(contentType, buffer, {
    maxPages: 1,
    maxTotalPixels: EVENT_MEDIA_MAX_INPUT_PIXELS,
  });
  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format as 'jpeg' | 'png' | 'webp',
  };
}

const PDF_MAX_PAGES = 500;
const PDF_MAX_OBJECTS = 10_000;
const PDF_MAX_STREAMS = 2_000;
const PDF_MAX_LEXICAL_TOKENS = 200_000;
const PDF_FORBIDDEN_NAMES = new Set([
  'A',
  'AA',
  'Action',
  'OpenAction',
  'AcroForm',
  'Annots',
  'Annot',
  'GoTo',
  'GoToR',
  'GoToE',
  'Named',
  'Sound',
  'Movie',
  'Hide',
  'ResetForm',
  'SetOCGState',
  'Rendition',
  'Trans',
  'GoTo3DView',
  'FileAttachment',
  'Screen',
  '3D',
  'JS',
  'JavaScript',
  'Launch',
  'EmbeddedFile',
  'EmbeddedFiles',
  'Filespec',
  'RichMedia',
  'URI',
  'SubmitForm',
  'ImportData',
  'XFA',
  'Encrypt',
]);

type PdfLexicalToken = {
  kind: 'name' | 'word' | 'dict-open' | 'dict-close' | 'array-open' | 'array-close' | 'opaque';
  value: string;
};

function isPdfWhitespaceCode(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
}

function isPdfDelimiter(character: string): boolean {
  return '()<>[]{}/%'.includes(character);
}

function tokenizePdfSemanticSource(source: string): PdfLexicalToken[] {
  const tokens: PdfLexicalToken[] = [];
  const add = (token: PdfLexicalToken): void => {
    tokens.push(token);
    if (tokens.length > PDF_MAX_LEXICAL_TOKENS)
      throw new ValidationError('Checkout PDF lexical structure exceeds safety limits');
  };
  let offset = 0;
  while (offset < source.length) {
    const character = source[offset]!;
    const code = source.charCodeAt(offset);
    if (isPdfWhitespaceCode(code)) {
      offset += 1;
      continue;
    }
    if (character === '%') {
      while (offset < source.length && source[offset] !== '\r' && source[offset] !== '\n')
        offset += 1;
      continue;
    }
    if (character === '(') {
      let depth = 1;
      offset += 1;
      while (offset < source.length && depth > 0) {
        const stringCharacter = source[offset]!;
        if (stringCharacter === '\\') {
          offset += 1;
          if (source[offset] === '\r' && source[offset + 1] === '\n') offset += 2;
          else if (offset < source.length) offset += 1;
        } else {
          if (stringCharacter === '(') depth += 1;
          else if (stringCharacter === ')') depth -= 1;
          offset += 1;
        }
      }
      if (depth !== 0) throw new ValidationError('Checkout PDF contains an unterminated string');
      add({ kind: 'opaque', value: 'literal-string' });
      continue;
    }
    if (character === '<' && source[offset + 1] !== '<') {
      offset += 1;
      let closed = false;
      while (offset < source.length) {
        const hexCharacter = source[offset]!;
        if (hexCharacter === '>') {
          offset += 1;
          closed = true;
          break;
        }
        if (!isPdfWhitespaceCode(source.charCodeAt(offset)) && !/[0-9a-fA-F]/.test(hexCharacter))
          throw new ValidationError('Checkout PDF contains an invalid hex string');
        offset += 1;
      }
      if (!closed) throw new ValidationError('Checkout PDF contains an unterminated hex string');
      add({ kind: 'opaque', value: 'hex-string' });
      continue;
    }
    if (source.startsWith('<<', offset)) {
      add({ kind: 'dict-open', value: '<<' });
      offset += 2;
      continue;
    }
    if (source.startsWith('>>', offset)) {
      add({ kind: 'dict-close', value: '>>' });
      offset += 2;
      continue;
    }
    if (character === '[' || character === ']') {
      add({ kind: character === '[' ? 'array-open' : 'array-close', value: character });
      offset += 1;
      continue;
    }
    if (character === '/') {
      const start = ++offset;
      while (
        offset < source.length &&
        !isPdfWhitespaceCode(source.charCodeAt(offset)) &&
        !isPdfDelimiter(source[offset]!)
      )
        offset += 1;
      const name = source.slice(start, offset);
      if (/#[0-9a-fA-F]{2}/.test(name))
        throw new ValidationError(
          'Checkout PDF uses encoded names that cannot be inspected safely',
        );
      add({ kind: 'name', value: name });
      continue;
    }
    if (isPdfDelimiter(character))
      throw new ValidationError('Checkout PDF contains an unsupported lexical delimiter');
    const start = offset;
    while (
      offset < source.length &&
      !isPdfWhitespaceCode(source.charCodeAt(offset)) &&
      !isPdfDelimiter(source[offset]!)
    )
      offset += 1;
    add({ kind: 'word', value: source.slice(start, offset) });
  }
  return tokens;
}

function assertSinglePdfDictionary(tokens: PdfLexicalToken[], label: string): void {
  if (tokens[0]?.kind !== 'dict-open')
    throw new ValidationError(`Checkout PDF ${label} must be one dictionary`);
  let depth = 0;
  let arrayDepth = 0;
  for (const [index, token] of tokens.entries()) {
    if (token.kind === 'dict-open') depth += 1;
    else if (token.kind === 'dict-close') depth -= 1;
    else if (token.kind === 'array-open') arrayDepth += 1;
    else if (token.kind === 'array-close') arrayDepth -= 1;
    if (depth < 0 || arrayDepth < 0 || (depth === 0 && index !== tokens.length - 1))
      throw new ValidationError(`Checkout PDF ${label} dictionary boundary is ambiguous`);
  }
  if (depth !== 0 || arrayDepth !== 0 || tokens.at(-1)?.kind !== 'dict-close')
    throw new ValidationError(`Checkout PDF ${label} dictionary is unbalanced`);
}

function topLevelPdfNameIndexes(tokens: PdfLexicalToken[], name: string): number[] {
  const indexes: number[] = [];
  let depth = 0;
  let arrayDepth = 0;
  for (const [index, token] of tokens.entries()) {
    if (token.kind === 'dict-open') depth += 1;
    else if (token.kind === 'dict-close') depth -= 1;
    else if (token.kind === 'array-open') arrayDepth += 1;
    else if (token.kind === 'array-close') arrayDepth -= 1;
    else if (depth === 1 && arrayDepth === 0 && token.kind === 'name' && token.value === name)
      indexes.push(index);
  }
  return indexes;
}

function pdfObjectBody(objectSource: string, objectNumber: number, generation: number): string {
  const header = `${objectNumber} ${generation} obj`;
  const endObjectOffset = objectSource.lastIndexOf('endobj');
  if (!objectSource.startsWith(header) || endObjectOffset < header.length)
    throw new ValidationError('Checkout PDF object body cannot be resolved safely');
  return objectSource.slice(header.length, endObjectOffset).trim();
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

type ClassicPdfXrefEntry = {
  objectNumber: number;
  offset: number;
  generation: number;
  inUse: boolean;
};

function readPdfLine(source: string, offset: number): { line: string; next: number } {
  const ending = /\r\n|\r|\n/g;
  ending.lastIndex = offset;
  const match = ending.exec(source);
  if (!match) throw new ValidationError('Checkout PDF structure is invalid or incomplete');
  return { line: source.slice(offset, match.index), next: match.index + match[0].length };
}

function isPdfWhitespaceOnly(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d && code !== 0x20)
      return false;
  }
  return true;
}

function assertPdfObjectStructure(
  source: string,
  entry: ClassicPdfXrefEntry,
  boundary: number,
): string {
  const objectSource = source.slice(entry.offset, boundary);
  const header = `${entry.objectNumber} ${entry.generation} obj`;
  if (!objectSource.startsWith(header) || !/^[\t\r\n ]/.test(objectSource.slice(header.length)))
    throw new ValidationError('Checkout PDF xref entry does not point to its declared object');
  if (countMatches(objectSource, /\bendobj\b/g) !== 1)
    throw new ValidationError('Checkout PDF object boundary is ambiguous');

  const streamOpenings = [...objectSource.matchAll(/(?:\r\n|\r|\n)stream(?:\r\n|\r|\n)/g)];
  const streamClosings = [...objectSource.matchAll(/(?:\r\n|\r|\n)endstream\b/g)];
  if (streamOpenings.length === 0 && streamClosings.length === 0) {
    const endObjectOffset = objectSource.indexOf('endobj');
    if (!isPdfWhitespaceOnly(objectSource.slice(endObjectOffset + 'endobj'.length)))
      throw new ValidationError('Checkout PDF object has trailing content outside its boundary');
    return objectSource;
  }
  if (streamOpenings.length !== 1 || streamClosings.length !== 1)
    throw new ValidationError('Checkout PDF stream structure is unsupported or ambiguous');

  const opening = streamOpenings[0]!;
  const dictionary = objectSource.slice(header.length, opening.index);
  const dictionaryTokens = tokenizePdfSemanticSource(dictionary);
  assertSinglePdfDictionary(dictionaryTokens, 'stream object');
  const lengthIndexes = topLevelPdfNameIndexes(dictionaryTokens, 'Length');
  const lengthIndex = lengthIndexes[0];
  const lengthToken = lengthIndex === undefined ? undefined : dictionaryTokens[lengthIndex + 1];
  if (
    lengthIndexes.length !== 1 ||
    lengthToken?.kind !== 'word' ||
    !/^\d+$/.test(lengthToken.value) ||
    (dictionaryTokens[lengthIndex! + 2]?.kind === 'word' &&
      /^\d+$/.test(dictionaryTokens[lengthIndex! + 2]!.value) &&
      dictionaryTokens[lengthIndex! + 3]?.kind === 'word' &&
      dictionaryTokens[lengthIndex! + 3]?.value === 'R')
  )
    throw new ValidationError('Checkout PDF stream must have one direct length');
  const streamLength = Number(lengthToken.value);
  const dataStart = opening.index! + opening[0].length;
  const dataEnd = dataStart + streamLength;
  if (!Number.isSafeInteger(streamLength) || streamLength < 0 || dataEnd > objectSource.length)
    throw new ValidationError('Checkout PDF stream length is invalid');
  const afterData = objectSource.slice(dataEnd);
  const closing = /^(?:\r\n|\r|\n)endstream\b/.exec(afterData);
  if (
    !closing ||
    dataEnd + closing[0].length !== streamClosings[0]!.index! + streamClosings[0]![0].length
  )
    throw new ValidationError('Checkout PDF stream length does not match its boundary');
  const afterStream = afterData.slice(closing[0].length);
  const endObject = /^[\t\r\n ]*endobj\b/.exec(afterStream);
  if (!endObject || !isPdfWhitespaceOnly(afterStream.slice(endObject[0].length)))
    throw new ValidationError('Checkout PDF stream is not followed by its object boundary');
  return `${objectSource.slice(0, dataStart)}${afterStream}`;
}

function validateCheckoutPdf(buffer: Buffer): void {
  const source = buffer.toString('latin1');
  if (!/^%PDF-1\.[0-7](?:\r\n|\r|\n)/.test(source))
    throw new ValidationError('Checkout PDF has an invalid signature');
  if (!/%%EOF[\t\r\n ]*$/.test(source))
    throw new ValidationError('Checkout PDF is truncated or contains trailing data');
  if (
    countMatches(source, /^xref[\t\r ]*$/gm) !== 1 ||
    countMatches(source, /^trailer[\t\r ]*$/gm) !== 1 ||
    countMatches(source, /^startxref[\t\r ]*$/gm) !== 1 ||
    countMatches(source, /^%%EOF[\t\r ]*$/gm) !== 1 ||
    countMatches(source, /^%PDF-1\.[0-7][\t\r ]*$/gm) !== 1
  )
    throw new ValidationError('Checkout PDF must contain exactly one classic revision');

  const startXrefMatch = /^startxref\r?\n(\d+)\r?\n%%EOF[\t ]*(?:\r?\n)?[\t\r\n ]*$/m.exec(source);
  const xrefOffset = startXrefMatch ? Number(startXrefMatch[1]) : Number.NaN;
  if (
    !Number.isSafeInteger(xrefOffset) ||
    xrefOffset <= 0 ||
    xrefOffset >= buffer.length ||
    source.slice(xrefOffset, xrefOffset + 4) !== 'xref'
  )
    throw new ValidationError('Checkout PDF startxref is invalid');

  let cursor = xrefOffset;
  const xrefHeader = readPdfLine(source, cursor);
  if (xrefHeader.line !== 'xref')
    throw new ValidationError('Checkout PDF startxref does not point to a classic xref');
  cursor = xrefHeader.next;
  const entries = new Map<number, ClassicPdfXrefEntry>();
  while (true) {
    const headerLine = readPdfLine(source, cursor);
    cursor = headerLine.next;
    if (headerLine.line === 'trailer') break;
    const subsection = /^(\d+) (\d+)$/.exec(headerLine.line);
    if (!subsection) throw new ValidationError('Checkout PDF xref subsection header is invalid');
    const firstObject = Number(subsection[1]);
    const count = Number(subsection[2]);
    if (
      !Number.isSafeInteger(firstObject) ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      entries.size + count > PDF_MAX_OBJECTS + 1
    )
      throw new ValidationError('Checkout PDF xref subsection exceeds safety limits');
    for (let index = 0; index < count; index += 1) {
      const row = readPdfLine(source, cursor);
      cursor = row.next;
      const parsed = /^(\d{10}) (\d{5}) ([nf]) ?$/.exec(row.line);
      const objectNumber = firstObject + index;
      if (!parsed || !Number.isSafeInteger(objectNumber) || entries.has(objectNumber))
        throw new ValidationError('Checkout PDF xref row is invalid or duplicated');
      entries.set(objectNumber, {
        objectNumber,
        offset: Number(parsed[1]),
        generation: Number(parsed[2]),
        inUse: parsed[3] === 'n',
      });
    }
  }

  const startXrefLineIndex = startXrefMatch!.index;
  if (startXrefLineIndex < cursor) throw new ValidationError('Checkout PDF trailer is incomplete');
  const trailerSource = source.slice(cursor, startXrefLineIndex).trim();
  const trailerTokens = tokenizePdfSemanticSource(trailerSource);
  assertSinglePdfDictionary(trailerTokens, 'trailer');
  const sizeIndexes = topLevelPdfNameIndexes(trailerTokens, 'Size');
  const rootIndexes = topLevelPdfNameIndexes(trailerTokens, 'Root');
  if (sizeIndexes.length !== 1 || rootIndexes.length !== 1)
    throw new ValidationError('Checkout PDF trailer must declare one size and root');
  const sizeIndex = sizeIndexes[0]!;
  const rootIndex = rootIndexes[0]!;
  const sizeToken = trailerTokens[sizeIndex + 1];
  const rootObjectToken = trailerTokens[rootIndex + 1];
  const rootGenerationToken = trailerTokens[rootIndex + 2];
  const rootReferenceToken = trailerTokens[rootIndex + 3];
  if (
    sizeToken?.kind !== 'word' ||
    !/^\d+$/.test(sizeToken.value) ||
    rootObjectToken?.kind !== 'word' ||
    !/^\d+$/.test(rootObjectToken.value) ||
    rootGenerationToken?.kind !== 'word' ||
    !/^\d+$/.test(rootGenerationToken.value) ||
    rootReferenceToken?.kind !== 'word' ||
    rootReferenceToken.value !== 'R'
  )
    throw new ValidationError('Checkout PDF trailer size or root reference is invalid');
  const declaredSize = Number(sizeToken.value);
  const highestObject = Math.max(...entries.keys());
  if (
    !Number.isSafeInteger(declaredSize) ||
    declaredSize < 2 ||
    declaredSize > PDF_MAX_OBJECTS + 1 ||
    declaredSize !== highestObject + 1 ||
    entries.size !== declaredSize ||
    Array.from({ length: declaredSize }, (_, objectNumber) => objectNumber).some(
      (objectNumber) => !entries.has(objectNumber),
    )
  )
    throw new ValidationError('Checkout PDF trailer size does not match its xref');
  const rowZero = entries.get(0);
  if (!rowZero || rowZero.inUse || rowZero.generation !== 65_535)
    throw new ValidationError('Checkout PDF xref row zero is invalid');
  for (const entry of entries.values()) {
    if (entry.inUse) {
      if (
        entry.objectNumber === 0 ||
        entry.generation >= 65_535 ||
        entry.offset <= 0 ||
        entry.offset >= xrefOffset
      )
        throw new ValidationError('Checkout PDF in-use xref row is out of range');
    } else if (entry.objectNumber !== 0 && (entry.offset < 0 || entry.offset >= declaredSize)) {
      throw new ValidationError('Checkout PDF free xref row is out of range');
    }
  }
  const freeObjects = new Set(
    [...entries.values()]
      .filter((entry) => !entry.inUse && entry.objectNumber !== 0)
      .map((entry) => entry.objectNumber),
  );
  const visitedFreeObjects = new Set<number>();
  let nextFreeObject = rowZero.offset;
  while (nextFreeObject !== 0) {
    const freeEntry = entries.get(nextFreeObject);
    if (!freeEntry || freeEntry.inUse || visitedFreeObjects.has(nextFreeObject))
      throw new ValidationError('Checkout PDF xref free-list chain is invalid');
    visitedFreeObjects.add(nextFreeObject);
    nextFreeObject = freeEntry.offset;
  }
  if (
    visitedFreeObjects.size !== freeObjects.size ||
    [...freeObjects].some((objectNumber) => !visitedFreeObjects.has(objectNumber))
  )
    throw new ValidationError('Checkout PDF xref free-list chain is incomplete');

  const inUseEntries = [...entries.values()]
    .filter((entry) => entry.inUse)
    .sort((left, right) => left.offset - right.offset);
  if (inUseEntries.length < 1 || inUseEntries.length > PDF_MAX_OBJECTS)
    throw new ValidationError('Checkout PDF object count exceeds safety limits');
  const declaredHeaders = [...source.slice(0, xrefOffset).matchAll(/^(\d+) (\d+) obj\b/gm)];
  if (declaredHeaders.length !== inUseEntries.length)
    throw new ValidationError('Checkout PDF contains objects not uniquely bound by its xref');
  const semanticObjects = new Map<number, string>();
  for (const [index, entry] of inUseEntries.entries()) {
    const boundary = inUseEntries[index + 1]?.offset ?? xrefOffset;
    semanticObjects.set(entry.objectNumber, assertPdfObjectStructure(source, entry, boundary));
  }
  if (countMatches(source, /(?:^|[\r\n])stream(?:\r\n|\r|\n)/g) > PDF_MAX_STREAMS)
    throw new ValidationError('Checkout PDF stream count exceeds safety limits');

  const objectTokens = new Map<number, PdfLexicalToken[]>();
  for (const [objectNumber, semanticObject] of semanticObjects)
    objectTokens.set(objectNumber, tokenizePdfSemanticSource(semanticObject));
  const allSemanticTokens = [trailerTokens, ...objectTokens.values()].flat();
  if (
    allSemanticTokens.some(
      (token) =>
        token.kind === 'name' &&
        (PDF_FORBIDDEN_NAMES.has(token.value) ||
          token.value === 'Prev' ||
          token.value === 'XRefStm' ||
          token.value === 'ObjStm' ||
          token.value === 'XRef'),
    )
  )
    throw new ValidationError(
      'Checkout PDF contains an unsupported interactive or structural name',
    );

  const rootNumber = Number(rootObjectToken.value);
  const rootGeneration = Number(rootGenerationToken.value);
  const rootEntry = entries.get(rootNumber);
  const rootObject = semanticObjects.get(rootNumber);
  if (!rootEntry?.inUse || rootEntry.generation !== rootGeneration || !rootObject)
    throw new ValidationError('Checkout PDF root does not resolve to its catalog object');
  const rootBody = pdfObjectBody(rootObject, rootNumber, rootGeneration);
  const rootTokens = tokenizePdfSemanticSource(rootBody);
  assertSinglePdfDictionary(rootTokens, 'root object');
  const rootTypeIndexes = topLevelPdfNameIndexes(rootTokens, 'Type');
  if (
    rootTypeIndexes.length !== 1 ||
    rootTokens[rootTypeIndexes[0]! + 1]?.kind !== 'name' ||
    rootTokens[rootTypeIndexes[0]! + 1]?.value !== 'Catalog'
  )
    throw new ValidationError('Checkout PDF root must declare exactly one top-level Catalog type');

  let pageCount = 0;
  for (const entry of inUseEntries) {
    const semanticObject = semanticObjects.get(entry.objectNumber)!;
    const bodyTokens = tokenizePdfSemanticSource(
      pdfObjectBody(semanticObject, entry.objectNumber, entry.generation),
    );
    if (
      bodyTokens[0]?.kind !== 'dict-open' ||
      bodyTokens.some((token) => token.kind === 'word' && token.value === 'stream')
    )
      continue;
    assertSinglePdfDictionary(bodyTokens, `object ${entry.objectNumber}`);
    const typeIndexes = topLevelPdfNameIndexes(bodyTokens, 'Type');
    if (
      typeIndexes.length === 1 &&
      bodyTokens[typeIndexes[0]! + 1]?.kind === 'name' &&
      bodyTokens[typeIndexes[0]! + 1]?.value === 'Page'
    )
      pageCount += 1;
  }
  if (pageCount < 1 || pageCount > PDF_MAX_PAGES)
    throw new ValidationError('Checkout PDF page count exceeds safety limits');
}

const CHECKOUT_TEXT_MAX_LINE_LENGTH = 16_384;

function containsForbiddenTextControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    )
      return true;
  }
  return false;
}

function validateCheckoutText(buffer: Buffer): void {
  if (
    (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) ||
    (buffer[0] === 0xff && buffer[1] === 0xfe) ||
    (buffer[0] === 0xfe && buffer[1] === 0xff)
  ) {
    throw new ValidationError('Checkout text must be unmarked UTF-8');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new ValidationError('Checkout text is not valid UTF-8');
  }
  if (containsForbiddenTextControl(text) || text.includes('\uFEFF'))
    throw new ValidationError('Checkout text contains binary or control characters');
  if (text.split(/\r\n|\r|\n/u).some((line) => line.length > CHECKOUT_TEXT_MAX_LINE_LENGTH))
    throw new ValidationError('Checkout text contains an excessively long line');
}

async function validateUploadContent(
  purpose: UploadPurpose,
  contentType: string,
  buffer: Buffer,
): Promise<{
  persistedBuffer: Buffer;
  eventMediaMetadata: null | {
    width: number;
    height: number;
    format: 'jpeg' | 'png' | 'webp';
  };
}> {
  if (contentType.startsWith('image/')) {
    if (EVENT_MEDIA_PURPOSES.has(purpose)) {
      return {
        persistedBuffer: buffer,
        eventMediaMetadata: await inspectEventMediaImage(contentType, buffer),
      };
    }
    await inspectFullyDecodedImage(contentType, buffer, {
      maxPages: GENERIC_IMAGE_MAX_PAGES,
      maxTotalPixels: GENERIC_IMAGE_MAX_TOTAL_PIXELS,
    });
    // Generic public images have no original-preservation contract. Re-encoding in the
    // declared format strips EXIF/GPS and other untrusted metadata before publication.
    const persistedBuffer = await sanitizeGenericImage(contentType, buffer);
    if (persistedBuffer.length > PURPOSE_LIMITS[purpose].maxSizeBytes)
      throw new ValidationError('Sanitized image exceeds the upload byte limit');
    return { persistedBuffer, eventMediaMetadata: null };
  } else if (purpose === 'checkout_answer' && contentType === 'application/pdf') {
    validateCheckoutPdf(buffer);
  } else if (purpose === 'checkout_answer' && contentType === 'text/plain') {
    validateCheckoutText(buffer);
  }
  return { persistedBuffer: buffer, eventMediaMetadata: null };
}

class UploadScannerUnavailableError extends Error {
  readonly code = 'SERVICE_UNAVAILABLE';
  readonly statusCode = 503;
  readonly expose = true;

  constructor(message = UPLOAD_SCANNER_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = 'UploadScannerUnavailableError';
  }
}

function uploadScannerMode(): string {
  return (
    process.env.UPLOAD_MALWARE_SCANNER ?? (process.env.NODE_ENV === 'production' ? '' : 'eicar')
  );
}

function assertProductionUploadScannerConfigured(mode: string): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (mode !== 'clamav') throw new UploadScannerUnavailableError();
  clamAvConfiguration();
}

function clamAvConfiguration(): { host: string; port: number; timeoutMs: number } {
  const rawHost = process.env.CLAMAV_HOST ?? '';
  const host = rawHost.trim();
  const rawPort = process.env.CLAMAV_PORT ?? String(CLAMAV_DEFAULT_PORT);
  const rawTimeout = process.env.CLAMAV_TIMEOUT_MS ?? String(CLAMAV_DEFAULT_TIMEOUT_MS);
  if (
    host.length === 0 ||
    host !== rawHost ||
    host.length > 253 ||
    !/^\d+$/u.test(rawPort) ||
    !/^\d+$/u.test(rawTimeout)
  )
    throw new UploadScannerUnavailableError();
  const port = Number(rawPort);
  const timeoutMs = Number(rawTimeout);
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < CLAMAV_MIN_TIMEOUT_MS ||
    timeoutMs > CLAMAV_MAX_TIMEOUT_MS
  )
    throw new UploadScannerUnavailableError();
  return { host, port, timeoutMs };
}

function finalObjectKeyFromStaging(stagingKey: string, checksum: string): string {
  const immutableSuffix = `/${checksum}`;
  if (stagingKey.includes('/staging/'))
    return `${stagingKey.replace('/staging/', '/final/')}${immutableSuffix}`;
  return `${stagingKey}.final${immutableSuffix}`;
}

function createS3Client(endpoint = config.s3Endpoint): S3Client {
  const options: S3ClientConfig = {
    region: config.s3Region,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  };
  if (endpoint) options.endpoint = endpoint;
  if (config.s3AccessKeyId && config.s3SecretAccessKey) {
    options.credentials = {
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
    };
  }
  return new S3Client(options);
}

function createS3SigningClient(): S3Client {
  return createS3Client(process.env.S3_PUBLIC_ENDPOINT?.trim() || config.s3Endpoint);
}

async function bodyToBuffer(
  body: unknown,
  maximumBytes = Number.POSITIVE_INFINITY,
): Promise<Buffer> {
  if (body && Symbol.asyncIterator in Object(body)) {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maximumBytes) throw new ValidationError('Uploaded object exceeds its size limit');
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
  }
  if (
    !body ||
    typeof (body as { transformToByteArray?: unknown }).transformToByteArray !== 'function'
  ) {
    return Buffer.alloc(0);
  }
  const bytes = await (
    body as { transformToByteArray(): Promise<Uint8Array> }
  ).transformToByteArray();
  const buffer = Buffer.from(bytes);
  if (buffer.length > maximumBytes)
    throw new ValidationError('Uploaded object exceeds its size limit');
  return buffer;
}

async function scanWithClamAv(buffer: Buffer): Promise<{ clean: boolean; result: string }> {
  const { host, port, timeoutMs } = clamAvConfiguration();

  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const chunks: Buffer[] = [];
    let responseBytes = 0;
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const unavailable = (): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      socket.destroy();
      reject(new UploadScannerUnavailableError());
    };
    const complete = (result: { clean: boolean; result: string }): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      socket.destroy();
      resolve(result);
    };
    deadline = setTimeout(unavailable, timeoutMs);
    socket.setTimeout(timeoutMs);
    socket.on('data', (chunk) => {
      responseBytes += chunk.length;
      if (responseBytes > CLAMAV_MAX_RESPONSE_BYTES) {
        unavailable();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    socket.on('error', unavailable);
    socket.on('timeout', () => {
      unavailable();
    });
    socket.on('end', () => {
      if (settled) return;
      let response: string;
      try {
        const responseBuffer = Buffer.concat(chunks);
        if (
          responseBuffer.length < 2 ||
          responseBuffer.at(-1) !== 0 ||
          responseBuffer.subarray(0, -1).includes(0)
        ) {
          unavailable();
          return;
        }
        response = new TextDecoder('utf-8', { fatal: true }).decode(
          responseBuffer.subarray(0, -1),
        );
      } catch {
        unavailable();
        return;
      }
      if (response === 'stream: OK') {
        complete({ clean: true, result: response });
        return;
      }
      if (/^stream: [^\r\n]{1,512} FOUND$/u.test(response)) {
        complete({ clean: false, result: response });
        return;
      }
      unavailable();
    });
    socket.on('close', () => {
      if (!settled) unavailable();
    });
    socket.connect(port, host, () => {
      try {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < buffer.length; offset += 8192) {
          const chunk = buffer.subarray(offset, offset + 8192);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length, 0);
          socket.write(size);
          socket.write(chunk);
        }
        socket.end(Buffer.alloc(4));
      } catch {
        unavailable();
      }
    });
  });
}

function isMissingS3ObjectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.Code === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

async function markUploadArtifactRejected(
  db: Database,
  artifactId: string,
  result: string,
): Promise<void> {
  await db
    .updateTable('upload_artifacts')
    .set({
      status: 'rejected',
      scan_status: 'blocked',
      scan_result: result,
      updated_at: new Date(),
    })
    .where('id', '=', artifactId)
    .execute();
}

async function tryDeleteUploadObject(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function cleanupExpiredUploadArtifacts(
  db: Database,
  now = new Date(),
  limit = 100,
  observer?: {
    artifactClaimStarted?(artifactId: string): Promise<void> | void;
    artifactClaimed?(artifactId: string): Promise<void> | void;
  },
): Promise<number> {
  const staleCleanupClaimBefore = new Date(now.getTime() - 15 * 60 * 1000);
  const rows = await db
    .selectFrom('upload_artifacts')
    .select([
      'id',
      'tenant_id',
      'organization_id',
      'brand_id',
      'status',
      'scan_result',
      'bucket',
      'object_key',
      'purpose',
      'event_id',
      'content_type',
      'size_bytes',
      'checksum_sha256',
      'consumed_at',
      'updated_at',
    ])
    .where((eb) =>
      eb.or([
        eb('status', 'in', ['pending', 'rejected']),
        eb.and([
          eb('status', '=', 'uploaded'),
          eb('purpose', 'in', [
            'event_poster',
            'event_cover',
            'event_social',
            'event_seo_image',
            'migration_import',
          ]),
        ]),
        eb.and([
          eb('status', '=', 'cleanup_pending'),
          eb('updated_at', '<', staleCleanupClaimBefore),
        ]),
      ]),
    )
    .where('expires_at', '<', now)
    .orderBy('expires_at')
    .limit(limit)
    .execute();

  if (rows.length === 0) return 0;

  const s3 = createS3Client();
  const cleaned = await Promise.all(
    rows.map(async (row) => {
      if (row.status === 'uploaded' && row.purpose !== 'migration_import') {
        if (!row.event_id || !EVENT_MEDIA_PURPOSES.has(row.purpose as UploadPurpose)) {
          return false;
        }
        const structuredReference = await db
          .selectFrom('event_media_assets')
          .select('id')
          .where('upload_artifact_id', '=', row.id)
          .where('tenant_id', '=', row.tenant_id)
          .where('organization_id', '=', row.organization_id!)
          .where('brand_id', '=', row.brand_id!)
          .where('event_id', '=', row.event_id)
          .executeTakeFirst();
        const event = await db
          .selectFrom('events')
          .select(['cover_image_url', 'seo'])
          .where('id', '=', row.event_id)
          .where('tenant_id', '=', row.tenant_id)
          .where('organization_id', '=', row.organization_id!)
          .where('brand_id', '=', row.brand_id!)
          .executeTakeFirst();
        const referenced =
          event?.cover_image_url?.includes(row.id) === true ||
          (typeof event?.seo === 'string' && event.seo.includes(row.id));
        if (structuredReference || referenced) {
          await db
            .updateTable('upload_artifacts')
            .set({
              expires_at: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
            })
            .where('id', '=', row.id)
            .where('status', '=', 'uploaded')
            .execute();
          return false;
        }
      }
      let claimQuery = db
        .updateTable('upload_artifacts')
        .set({ status: 'cleanup_pending', updated_at: now })
        .where('id', '=', row.id)
        .where('status', '=', row.status)
        .where('expires_at', '<', now);
      if (row.status === 'cleanup_pending')
        claimQuery = claimQuery.where('updated_at', '<', staleCleanupClaimBefore);
      const claimPromise = claimQuery.executeTakeFirst();
      await observer?.artifactClaimStarted?.(row.id);
      const claim = await claimPromise;
      if (Number(claim.numUpdatedRows) !== 1) return false;
      await observer?.artifactClaimed?.(row.id);

      if (row.purpose === 'migration_import') {
        const files = row.organization_id
          ? await db
              .selectFrom('import_job_files')
              .select(['id', 'import_job_id', 'media_type', 'byte_size', 'sha256', 'status'])
              .where('tenant_id', '=', row.tenant_id)
              .where('organization_id', '=', row.organization_id)
              .where('object_key', '=', row.object_key)
              .execute()
          : [];
        const exactFile =
          files.length === 1 &&
          files[0]!.sha256 === row.checksum_sha256 &&
          Number(files[0]!.byte_size) === row.size_bytes &&
          files[0]!.media_type === row.content_type &&
          files[0]!.status === 'ready';
        const registrationConsistent = row.consumed_at !== null && exactFile;
        const unregisteredConsistent = row.consumed_at === null && files.length === 0;
        if (!registrationConsistent && !unregisteredConsistent) {
          await db
            .updateTable('upload_artifacts')
            .set({
              status: 'retention_hold',
              scan_result: 'Migration import retention linkage is inconsistent',
              updated_at: now,
            })
            .where('id', '=', row.id)
            .where('status', '=', 'cleanup_pending')
            .execute();
          return false;
        }
        if (registrationConsistent) {
          const job = await db
            .selectFrom('import_jobs')
            .select(['status', 'updated_at'])
            .where('tenant_id', '=', row.tenant_id)
            .where('organization_id', '=', row.organization_id!)
            .where('id', '=', files[0]!.import_job_id)
            .executeTakeFirst();
          if (!job) {
            await db
              .updateTable('upload_artifacts')
              .set({
                status: 'retention_hold',
                scan_result: 'Migration import retention job is missing',
                updated_at: now,
              })
              .where('id', '=', row.id)
              .where('status', '=', 'cleanup_pending')
              .execute();
            return false;
          }
          const maximumRetentionAt =
            new Date(row.consumed_at!).getTime() + MIGRATION_IMPORT_MAX_RETENTION_MS;
          const recentlyActive =
            new Date(job.updated_at).getTime() >=
            now.getTime() - MIGRATION_IMPORT_ACTIVE_RENEWAL_MS;
          if (
            MIGRATION_IMPORT_ACTIVE_JOB_STATUSES.has(job.status) &&
            recentlyActive &&
            now.getTime() < maximumRetentionAt
          ) {
            await db
              .updateTable('upload_artifacts')
              .set({
                status: 'uploaded',
                expires_at: new Date(
                  Math.min(now.getTime() + MIGRATION_IMPORT_ACTIVE_RENEWAL_MS, maximumRetentionAt),
                ),
                updated_at: now,
              })
              .where('id', '=', row.id)
              .where('status', '=', 'cleanup_pending')
              .execute();
            return false;
          }
        }
      }

      if (row.status === 'uploaded' && row.event_id) {
        const structuredReference = await db
          .selectFrom('event_media_assets')
          .select('id')
          .where('upload_artifact_id', '=', row.id)
          .where('tenant_id', '=', row.tenant_id)
          .where('organization_id', '=', row.organization_id!)
          .where('brand_id', '=', row.brand_id!)
          .where('event_id', '=', row.event_id)
          .executeTakeFirst();
        const attached = await db
          .selectFrom('events')
          .select(['cover_image_url', 'seo'])
          .where('id', '=', row.event_id)
          .where('tenant_id', '=', row.tenant_id)
          .where('organization_id', '=', row.organization_id!)
          .where('brand_id', '=', row.brand_id!)
          .executeTakeFirst();
        if (
          structuredReference ||
          attached?.cover_image_url?.includes(row.id) === true ||
          (typeof attached?.seo === 'string' && attached.seo.includes(row.id))
        ) {
          await db
            .updateTable('upload_artifacts')
            .set({
              status: 'uploaded',
              expires_at: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
              updated_at: now,
            })
            .where('id', '=', row.id)
            .where('status', '=', 'cleanup_pending')
            .execute();
          return false;
        }
      }
      const sharedArtifacts = await db
        .selectFrom('upload_artifacts')
        .select('id')
        .where('bucket', '=', row.bucket)
        .where('object_key', '=', row.object_key)
        .where('status', '=', 'uploaded')
        .execute();
      const sharedArtifactIds = sharedArtifacts
        .map((artifact) => artifact.id)
        .filter((artifactId) => artifactId !== row.id);
      const sharedAttachment =
        sharedArtifactIds.length > 0
          ? await db
              .selectFrom('event_media_assets')
              .select('id')
              .where('upload_artifact_id', 'in', sharedArtifactIds)
              .executeTakeFirst()
          : undefined;
      const retainEventMediaObject =
        EVENT_MEDIA_PURPOSES.has(row.purpose as UploadPurpose) &&
        Boolean(row.checksum_sha256) &&
        (row.object_key.includes('/final/') || row.object_key.includes('.final/')) &&
        row.object_key.endsWith(`/${row.checksum_sha256}`);
      if (
        !retainEventMediaObject &&
        !sharedAttachment &&
        !(await tryDeleteUploadObject(s3, row.bucket, row.object_key))
      ) {
        await db
          .updateTable('upload_artifacts')
          .set({
            status: row.status,
            expires_at: new Date(now.getTime() + 5 * 60 * 1000),
            updated_at: now,
          })
          .where('id', '=', row.id)
          .where('status', '=', 'cleanup_pending')
          .execute();
        return false;
      }
      const completed = await db
        .updateTable('upload_artifacts')
        .set({
          status: 'cleanup_complete',
          scan_status: 'blocked',
          scan_result:
            row.scan_result ??
            (row.status === 'uploaded'
              ? row.purpose === 'migration_import'
                ? 'Migration import artifact retention expired'
                : 'Unattached event media artifact expired'
              : 'Upload artifact expired before completion'),
          updated_at: now,
        })
        .where('id', '=', row.id)
        .where('status', '=', 'cleanup_pending')
        .executeTakeFirst();
      return Number(completed.numUpdatedRows) === 1;
    }),
  );

  return cleaned.filter(Boolean).length;
}

export async function scanUploadBuffer(
  buffer: Buffer,
): Promise<{ clean: boolean; result: string }> {
  const mode = uploadScannerMode();
  assertProductionUploadScannerConfigured(mode);
  if (mode === 'clamav') return scanWithClamAv(buffer);
  if (mode === 'eicar') {
    const text = buffer.toString('utf8');
    return text.includes(EICAR_SIGNATURE)
      ? { clean: false, result: 'EICAR test signature found' }
      : { clean: true, result: 'No EICAR test signature found' };
  }
  throw new UploadScannerUnavailableError();
}

export function parseUploadArtifactMetadata(metadata: unknown): Record<string, unknown> {
  let parsed = metadata;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new ValidationError('Upload artifact metadata is invalid');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('Upload artifact metadata is invalid');
  }
  return parsed as Record<string, unknown>;
}

export async function createUploadArtifact(
  db: Database,
  input: CreateUploadInput,
): Promise<UploadArtifactResponse> {
  assertUploadAllowed(input);
  assertProductionUploadScannerConfigured(uploadScannerMode());
  const id = `upl_${ulid()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + UPLOAD_TTL_SECONDS * 1000);
  const fileName = safeFileName(input.fileName);
  const limits = PURPOSE_LIMITS[input.purpose];
  try {
    await cleanupExpiredUploadArtifacts(db, now, 25);
  } catch {
    // Upload creation should not fail because best-effort stale-object cleanup failed.
  }
  const objectKeyPrefix = [
    'uploads',
    input.tenantId,
    limits.prefix,
    input.eventId ?? input.brandId ?? input.organizationId ?? input.createdByUserId ?? 'global',
  ].join('/');
  const objectKey = `${objectKeyPrefix}/staging/${id}${extension(fileName)}`;
  const completeToken = input.publicComplete ? randomBytes(32).toString('base64url') : undefined;
  const uploadHeaders = { 'Content-Type': input.contentType };
  const s3 = createS3SigningClient();
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: objectKey,
      ContentType: input.contentType,
      ContentLength: input.sizeBytes,
    }),
    {
      expiresIn: UPLOAD_TTL_SECONDS,
      signableHeaders: new Set(['content-type', 'content-length']),
    },
  );

  await db
    .insertInto('upload_artifacts')
    .values({
      id,
      tenant_id: input.tenantId,
      organization_id: input.organizationId ?? null,
      brand_id: input.brandId ?? null,
      event_id: input.eventId ?? null,
      created_by_user_id: input.createdByUserId ?? null,
      purpose: input.purpose,
      status: 'pending',
      scan_status: 'pending',
      scan_result: null,
      bucket: config.s3Bucket,
      object_key: objectKey,
      file_name: fileName,
      content_type: input.contentType,
      size_bytes: input.sizeBytes,
      checksum_sha256: null,
      client_token_hash: completeToken ? tokenHash(completeToken) : null,
      metadata: JSON.stringify(input.metadata ?? {}),
      expires_at: expiresAt,
      created_at: now,
      updated_at: now,
    })
    .execute();

  return {
    artifactId: id,
    uploadUrl,
    uploadHeaders,
    completeUrl: input.publicComplete
      ? `/v1/public/upload-artifacts/${id}/complete`
      : `/v1/upload-artifacts/${id}/complete`,
    completeToken,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function completeUploadArtifact(
  db: Database,
  artifactId: string,
): Promise<{ artifactId: string; status: string; scanStatus: string }> {
  const artifact = await db
    .selectFrom('upload_artifacts')
    .selectAll()
    .where('id', '=', artifactId)
    .executeTakeFirst();
  if (!artifact) throw new NotFoundError('UploadArtifact', artifactId);
  if (artifact.status === 'uploaded' && artifact.scan_status === 'clean') {
    return {
      artifactId,
      status: artifact.status,
      scanStatus: artifact.scan_status,
    };
  }
  if (new Date(artifact.expires_at) < new Date()) {
    const result = 'Upload artifact URL has expired';
    const s3 = createS3Client();
    await markUploadArtifactRejected(db, artifact.id, result);
    await tryDeleteUploadObject(s3, artifact.bucket, artifact.object_key);
    throw new ValidationError(result);
  }

  const claimToken = `ucl_${ulid()}`;
  const claimStartedAt = new Date();
  let claimQuery = db
    .updateTable('upload_artifacts')
    .set({
      status: 'processing',
      scan_status: 'scanning',
      completion_owner_token: claimToken,
      completion_started_at: claimStartedAt,
      updated_at: claimStartedAt,
    })
    .where('id', '=', artifact.id);
  if (artifact.status === 'pending' && artifact.scan_status === 'pending') {
    claimQuery = claimQuery.where('status', '=', 'pending').where('scan_status', '=', 'pending');
  } else if (
    artifact.status === 'processing' &&
    artifact.scan_status === 'scanning' &&
    new Date(artifact.updated_at).getTime() < claimStartedAt.getTime() - 5 * 60_000
  ) {
    claimQuery = claimQuery
      .where('status', '=', 'processing')
      .where('scan_status', '=', 'scanning')
      .where(
        'completion_owner_token',
        artifact.completion_owner_token === null ? 'is' : '=',
        artifact.completion_owner_token,
      );
  } else {
    throw new ValidationError('Upload artifact completion is already in progress');
  }
  const claim = await claimQuery.executeTakeFirst();
  if (Number(claim.numUpdatedRows) !== 1)
    throw new ValidationError('Upload artifact completion is already in progress');

  const rejectClaimedArtifact = async (result: string, checksumSha256?: string): Promise<void> => {
    const rejected = await db
      .updateTable('upload_artifacts')
      .set({
        status: 'rejected',
        scan_status: 'blocked',
        scan_result: result,
        checksum_sha256: checksumSha256 ?? artifact.checksum_sha256,
        completion_owner_token: null,
        completion_started_at: null,
        updated_at: new Date(),
      })
      .where('id', '=', artifact.id)
      .where('completion_owner_token', '=', claimToken)
      .executeTakeFirst();
    if (Number(rejected.numUpdatedRows) !== 1)
      throw new ValidationError('Upload artifact completion lease was lost');
  };

  const s3 = createS3Client();
  const stagingObjectKey = artifact.object_key;
  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: artifact.bucket, Key: stagingObjectKey }));
  } catch (error) {
    if (!isMissingS3ObjectError(error)) throw error;
    const result = 'Uploaded object is missing from storage';
    await rejectClaimedArtifact(result);
    throw new ValidationError(result);
  }
  const actualSize = Number(head.ContentLength ?? 0);
  const actualType = typeof head.ContentType === 'string' ? head.ContentType : '';
  try {
    assertUploadAllowed({
      purpose: artifact.purpose as UploadPurpose,
      contentType: actualType,
      sizeBytes: actualSize,
    });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    const result = `Uploaded object metadata is invalid: ${error.message}`;
    await rejectClaimedArtifact(result);
    await tryDeleteUploadObject(s3, artifact.bucket, stagingObjectKey);
    throw new ValidationError(result);
  }
  if (actualSize !== artifact.size_bytes) {
    const result = `Uploaded object size does not match declared size: expected ${artifact.size_bytes} bytes, received ${actualSize} bytes`;
    await rejectClaimedArtifact(result);
    await tryDeleteUploadObject(s3, artifact.bucket, stagingObjectKey);
    throw new ValidationError(result);
  }
  if (actualType !== artifact.content_type) {
    const result = `Uploaded object content type does not match declared content type: expected ${artifact.content_type}, received ${actualType}`;
    await rejectClaimedArtifact(result);
    await tryDeleteUploadObject(s3, artifact.bucket, stagingObjectKey);
    throw new ValidationError(result);
  }

  const object = await s3.send(
    new GetObjectCommand({ Bucket: artifact.bucket, Key: stagingObjectKey }),
  );
  const buffer = await bodyToBuffer(object.Body, artifact.size_bytes);
  const objectContentType =
    typeof object.ContentType === 'string' ? object.ContentType : actualType;
  if (buffer.length !== artifact.size_bytes) {
    const result = `Uploaded object size does not match declared size: expected ${artifact.size_bytes} bytes, received ${buffer.length} bytes`;
    await rejectClaimedArtifact(result);
    await tryDeleteUploadObject(s3, artifact.bucket, stagingObjectKey);
    throw new ValidationError(result);
  }
  if (objectContentType !== artifact.content_type) {
    const result = `Uploaded object content type does not match declared content type: expected ${artifact.content_type}, received ${objectContentType}`;
    await rejectClaimedArtifact(result);
    await tryDeleteUploadObject(s3, artifact.bucket, stagingObjectKey);
    throw new ValidationError(result);
  }
  let scan: Awaited<ReturnType<typeof scanUploadBuffer>>;
  try {
    scan = await scanUploadBuffer(buffer);
  } catch (error) {
    if (!(error instanceof UploadScannerUnavailableError)) throw error;
    const released = await db
      .updateTable('upload_artifacts')
      .set({
        status: 'pending',
        scan_status: 'pending',
        scan_result: null,
        completion_owner_token: null,
        completion_started_at: null,
        updated_at: new Date(),
      })
      .where('id', '=', artifact.id)
      .where('status', '=', 'processing')
      .where('scan_status', '=', 'scanning')
      .where('completion_owner_token', '=', claimToken)
      .executeTakeFirst();
    if (Number(released.numUpdatedRows) !== 1)
      throw new ValidationError('Upload artifact completion lease was lost');
    throw error;
  }
  const sourceChecksum = createHash('sha256').update(buffer).digest('hex');
  const now = new Date();
  if (!scan.clean) {
    await rejectClaimedArtifact(scan.result, sourceChecksum);
    await tryDeleteUploadObject(s3, artifact.bucket, stagingObjectKey);
    throw new ValidationError('Uploaded file failed malware scan');
  }

  let validatedContent: Awaited<ReturnType<typeof validateUploadContent>>;
  try {
    validatedContent = await validateUploadContent(
      artifact.purpose as UploadPurpose,
      artifact.content_type,
      buffer,
    );
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    await rejectClaimedArtifact(error.message, sourceChecksum);
    await tryDeleteUploadObject(s3, artifact.bucket, stagingObjectKey);
    throw error;
  }

  const persistedBuffer = validatedContent.persistedBuffer;
  const eventMediaMetadata = validatedContent.eventMediaMetadata;
  const checksum = createHash('sha256').update(persistedBuffer).digest('hex');

  const finalObjectKey = finalObjectKeyFromStaging(stagingObjectKey, checksum);
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: artifact.bucket,
        Key: finalObjectKey,
        Body: persistedBuffer,
        ContentType: artifact.content_type,
        ContentLength: persistedBuffer.length,
        ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
        ...s3PutEncryption(),
        IfNoneMatch: '*',
      }),
    );
  } catch (error) {
    const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (candidate.name !== 'PreconditionFailed' && candidate.$metadata?.httpStatusCode !== 412)
      throw error;
    const existing = await s3.send(
      new GetObjectCommand({ Bucket: artifact.bucket, Key: finalObjectKey }),
    );
    const existingBuffer = await bodyToBuffer(existing.Body, persistedBuffer.length);
    if (
      existingBuffer.length !== persistedBuffer.length ||
      createHash('sha256').update(existingBuffer).digest('hex') !== checksum
    )
      throw new ValidationError('Immutable upload object conflicts with completion evidence');
  }
  const finalized = await db
    .updateTable('upload_artifacts')
    .set({
      status: 'uploaded',
      scan_status: 'clean',
      scan_result: scan.result,
      checksum_sha256: checksum,
      size_bytes: persistedBuffer.length,
      object_key: finalObjectKey,
      metadata: eventMediaMetadata
        ? JSON.stringify({
            ...parseUploadArtifactMetadata(artifact.metadata),
            image: eventMediaMetadata,
          })
        : JSON.stringify(parseUploadArtifactMetadata(artifact.metadata)),
      completion_owner_token: null,
      completion_started_at: null,
      updated_at: now,
    })
    .where('id', '=', artifact.id)
    .where('status', '=', 'processing')
    .where('scan_status', '=', 'scanning')
    .where('completion_owner_token', '=', claimToken)
    .executeTakeFirst();
  if (Number(finalized.numUpdatedRows) !== 1)
    throw new ValidationError('Upload artifact completion lease was lost');
  await tryDeleteUploadObject(s3, artifact.bucket, stagingObjectKey);

  return { artifactId, status: 'uploaded', scanStatus: 'clean' };
}

export async function getUploadArtifactDownloadUrl(
  db: Database,
  artifactId: string,
): Promise<string> {
  const artifact = await db
    .selectFrom('upload_artifacts')
    .selectAll()
    .where('id', '=', artifactId)
    .executeTakeFirst();
  if (!artifact || artifact.status !== 'uploaded' || artifact.scan_status !== 'clean') {
    throw new NotFoundError('UploadArtifact', artifactId);
  }
  return getSignedUrl(
    createS3SigningClient(),
    new GetObjectCommand({
      Bucket: artifact.bucket,
      Key: artifact.object_key,
      ResponseContentType: artifact.content_type,
      ResponseContentDisposition: `attachment; filename="${artifact.file_name.replaceAll('"', '')}"`,
    }),
    { expiresIn: 900 },
  );
}

export async function readCleanUploadArtifact(
  db: Database,
  artifactId: string,
): Promise<{
  artifact: {
    id: string;
    tenant_id: string;
    organization_id: string | null;
    brand_id: string | null;
    event_id: string | null;
    purpose: string;
    bucket: string;
    object_key: string;
    content_type: string;
    size_bytes: number;
    checksum_sha256: string | null;
    metadata: string;
  };
  buffer: Buffer;
}> {
  const artifact = await db
    .selectFrom('upload_artifacts')
    .select([
      'id',
      'tenant_id',
      'organization_id',
      'brand_id',
      'event_id',
      'purpose',
      'bucket',
      'object_key',
      'content_type',
      'size_bytes',
      'checksum_sha256',
      'metadata',
      'status',
      'scan_status',
    ])
    .where('id', '=', artifactId)
    .executeTakeFirst();
  if (!artifact || artifact.status !== 'uploaded' || artifact.scan_status !== 'clean')
    throw new NotFoundError('UploadArtifact', artifactId);
  const object = await createS3Client().send(
    new GetObjectCommand({ Bucket: artifact.bucket, Key: artifact.object_key }),
  );
  const buffer = await bodyToBuffer(object.Body, artifact.size_bytes);
  const checksum = createHash('sha256').update(buffer).digest('hex');
  if (
    buffer.length !== artifact.size_bytes ||
    !artifact.checksum_sha256 ||
    checksum !== artifact.checksum_sha256
  )
    throw new ValidationError('Uploaded artifact storage evidence does not match');
  const { status: _status, scan_status: _scanStatus, ...safeArtifact } = artifact;
  return { artifact: safeArtifact, buffer };
}

export async function writeEventMediaRendition(input: {
  bucket: string;
  objectKey: string;
  body: Buffer;
  contentType: string;
  checksumSha256: string;
}): Promise<void> {
  await createS3Client().send(
    new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.objectKey,
      Body: input.body,
      ContentType: input.contentType,
      ContentLength: input.body.length,
      CacheControl: 'public, max-age=31536000, immutable',
      IfNoneMatch: '*',
      ChecksumSHA256: Buffer.from(input.checksumSha256, 'hex').toString('base64'),
      ...s3PutEncryption(),
    }),
  );
}

export async function deleteEventMediaRendition(
  bucket: string,
  objectKey: string,
): Promise<boolean> {
  return tryDeleteUploadObject(createS3Client(), bucket, objectKey);
}

export type PublicUploadArtifact = {
  bucket: string;
  objectKey: string;
  contentType: string;
  fileName: string;
};

async function getPublicUploadArtifact(
  db: Database,
  artifactId: string,
  purpose:
    | 'brand_logo'
    | 'content_email_image'
    | 'content_event_page_image'
    | 'event_cover'
    | 'event_poster'
    | 'event_social'
    | 'event_seo_image',
): Promise<PublicUploadArtifact> {
  const artifact = await db
    .selectFrom('upload_artifacts')
    .selectAll()
    .where('id', '=', artifactId)
    .executeTakeFirst();
  if (
    !artifact ||
    artifact.purpose !== purpose ||
    artifact.status !== 'uploaded' ||
    artifact.scan_status !== 'clean'
  ) {
    throw new NotFoundError('UploadArtifact', artifactId);
  }
  return {
    bucket: artifact.bucket,
    objectKey: artifact.object_key,
    contentType: artifact.content_type,
    fileName: artifact.file_name,
  };
}

export async function getContentEmailImageArtifact(
  db: Database,
  artifactId: string,
): Promise<PublicUploadArtifact> {
  return getPublicUploadArtifact(db, artifactId, 'content_email_image');
}

export async function getContentEventPageImageArtifact(
  db: Database,
  artifactId: string,
): Promise<PublicUploadArtifact> {
  return getPublicUploadArtifact(db, artifactId, 'content_event_page_image');
}

export async function getBrandLogoArtifact(
  db: Database,
  artifactId: string,
): Promise<PublicUploadArtifact> {
  return getPublicUploadArtifact(db, artifactId, 'brand_logo');
}

export async function streamPublicUploadArtifact(artifact: PublicUploadArtifact): Promise<{
  stream: NodeJS.ReadableStream;
  contentType: string;
  fileName: string;
}> {
  const s3 = createS3Client();
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: artifact.bucket,
      Key: artifact.objectKey,
    }),
  );
  const body = response.Body;
  if (!body || typeof body !== 'object' || !('pipe' in body)) {
    throw new Error('Unexpected S3 response body type for content email image');
  }
  return {
    stream: body as unknown as NodeJS.ReadableStream,
    contentType: artifact.contentType,
    fileName: artifact.fileName,
  };
}

export async function streamContentEmailImage(
  db: Database,
  artifactId: string,
): Promise<{
  stream: NodeJS.ReadableStream;
  contentType: string;
  fileName: string;
}> {
  return streamPublicUploadArtifact(await getContentEmailImageArtifact(db, artifactId));
}

export async function streamContentEventPageImage(
  db: Database,
  artifactId: string,
): Promise<{
  stream: NodeJS.ReadableStream;
  contentType: string;
  fileName: string;
}> {
  return streamPublicUploadArtifact(await getContentEventPageImageArtifact(db, artifactId));
}

export async function streamBrandLogo(
  db: Database,
  artifactId: string,
): Promise<{
  stream: NodeJS.ReadableStream;
  contentType: string;
  fileName: string;
}> {
  return streamPublicUploadArtifact(await getBrandLogoArtifact(db, artifactId));
}

function uploadArtifactAnswerEntries(answers: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(answers)
    .filter((entry): entry is [string, { artifactId: string }] =>
      Boolean(
        entry[1] &&
        typeof entry[1] === 'object' &&
        !Array.isArray(entry[1]) &&
        typeof (entry[1] as { artifactId?: unknown }).artifactId === 'string',
      ),
    )
    .map(([questionId, answer]) => [questionId, answer.artifactId]);
}

function metadataQuestionId(metadata: unknown): string | undefined {
  if (typeof metadata === 'string') {
    try {
      return metadataQuestionId(JSON.parse(metadata));
    } catch {
      return undefined;
    }
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const questionId = (metadata as { questionId?: unknown }).questionId;
  return typeof questionId === 'string' && questionId.length > 0 ? questionId : undefined;
}

type UploadArtifactClaimOptions = {
  checkoutSessionId?: string;
  claimedArtifactIds?: Set<string>;
};

function countUpdatedRows(result: { numUpdatedRows?: bigint | number } | undefined): number {
  return Number(result?.numUpdatedRows ?? 0);
}

export async function assertCompletedUploadArtifacts(
  db: Database,
  tenantId: string,
  eventId: string,
  answers: Record<string, unknown>,
  options: UploadArtifactClaimOptions = {},
): Promise<void> {
  const answerArtifacts = uploadArtifactAnswerEntries(answers);
  const artifactIds = answerArtifacts.map(([, artifactId]) => artifactId);
  if (artifactIds.length === 0) return;

  const duplicateArtifactIds = artifactIds.filter(
    (artifactId, index) => artifactIds.indexOf(artifactId) !== index,
  );
  const alreadyClaimedInPayload = options.claimedArtifactIds
    ? artifactIds.filter((artifactId) => options.claimedArtifactIds!.has(artifactId))
    : [];
  const repeatedArtifactIds = [...new Set([...duplicateArtifactIds, ...alreadyClaimedInPayload])];
  if (repeatedArtifactIds.length > 0) {
    throw new ValidationError('File answer upload artifacts can only be used once', {
      artifactIds: repeatedArtifactIds,
    });
  }

  const questionIdsByArtifactId = new Map<string, Set<string>>();
  for (const [questionId, artifactId] of answerArtifacts) {
    const questionIds = questionIdsByArtifactId.get(artifactId) ?? new Set<string>();
    questionIds.add(questionId);
    questionIdsByArtifactId.set(artifactId, questionIds);
  }

  const rows = await db
    .selectFrom('upload_artifacts')
    .select([
      'id',
      'purpose',
      'status',
      'scan_status',
      'metadata',
      'consumed_by_checkout_session_id',
    ])
    .where('tenant_id', '=', tenantId)
    .where('event_id', '=', eventId)
    .where('id', 'in', artifactIds)
    .execute();
  const valid = new Set<string>();
  const invalidPurpose = new Set<string>();
  const mismatched = new Set<string>();
  const missingQuestionMetadata = new Set<string>();
  const consumed = new Set<string>();
  for (const row of rows) {
    if (row.purpose !== 'checkout_answer') {
      invalidPurpose.add(row.id);
      continue;
    }
    if (row.status !== 'uploaded' || row.scan_status !== 'clean') continue;
    if (
      row.consumed_by_checkout_session_id &&
      row.consumed_by_checkout_session_id !== options.checkoutSessionId
    ) {
      consumed.add(row.id);
      continue;
    }

    const artifactQuestionId = metadataQuestionId(row.metadata);
    const answerQuestionIds = questionIdsByArtifactId.get(row.id);
    if (!artifactQuestionId) {
      missingQuestionMetadata.add(row.id);
      continue;
    }
    if (
      !answerQuestionIds ||
      [...answerQuestionIds].some((questionId) => questionId !== artifactQuestionId)
    ) {
      mismatched.add(row.id);
      continue;
    }

    valid.add(row.id);
  }

  if (invalidPurpose.size > 0) {
    throw new ValidationError(
      'File answer references an upload artifact that is not a checkout answer upload',
      {
        artifactIds: [...invalidPurpose],
      },
    );
  }

  if (mismatched.size > 0) {
    throw new ValidationError(
      'File answer references an upload artifact for a different question',
      {
        artifactIds: [...mismatched],
      },
    );
  }

  if (missingQuestionMetadata.size > 0) {
    throw new ValidationError(
      'File answer references an upload artifact without question metadata',
      {
        artifactIds: [...missingQuestionMetadata],
      },
    );
  }

  if (consumed.size > 0) {
    throw new ValidationError(
      'File answer references an upload artifact that has already been used',
      {
        artifactIds: [...consumed],
      },
    );
  }

  const missing = artifactIds.filter((artifactId) => !valid.has(artifactId));
  if (missing.length > 0) {
    throw new ValidationError(
      'File answer references an upload artifact that is not completed and clean',
      { artifactIds: missing },
    );
  }

  if (options.checkoutSessionId) {
    for (const artifactId of valid) {
      // eslint-disable-next-line no-await-in-loop -- each artifact must be claimed independently so replay races fail closed.
      const claimed = await db
        .updateTable('upload_artifacts')
        .set({
          consumed_by_checkout_session_id: options.checkoutSessionId,
          consumed_at: new Date(),
          updated_at: new Date(),
        })
        .where('id', '=', artifactId)
        .where('consumed_by_checkout_session_id', 'is', null)
        .executeTakeFirst();

      if (countUpdatedRows(claimed) === 0) {
        // eslint-disable-next-line no-await-in-loop -- re-read is scoped to the artifact that failed the conditional claim.
        const current = await db
          .selectFrom('upload_artifacts')
          .select(['consumed_by_checkout_session_id'])
          .where('id', '=', artifactId)
          .executeTakeFirst();
        if (current?.consumed_by_checkout_session_id !== options.checkoutSessionId) {
          throw new ValidationError(
            'File answer references an upload artifact that has already been used',
            {
              artifactIds: [artifactId],
            },
          );
        }
      }
    }
  }

  for (const artifactId of valid) {
    options.claimedArtifactIds?.add(artifactId);
  }
}
