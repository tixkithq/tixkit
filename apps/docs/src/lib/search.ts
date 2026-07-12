import type {
  Audience,
  DocsSearchFilters,
  DocsSearchRecord,
  DocsSearchResult,
  ProductArea,
} from '@tixkit/docs-core';

const aliases: Readonly<Record<string, readonly string[]>> = {
  api: ['integration', 'endpoint'],
  attendee: ['guest', 'ticket holder'],
  checkin: ['check-in', 'scan', 'scanner'],
  refund: ['return', 'reimburse'],
  webhook: ['callback', 'delivery', 'signature'],
};

export function tokenize(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    ),
  ];
}

function expandedTokens(value: string): string[] {
  const tokens = tokenize(value);
  return [
    ...new Set(tokens.flatMap((token) => [token, ...(aliases[token] ?? [])].flatMap(tokenize))),
  ];
}

function tokenScore(token: string, words: readonly string[], weight: number): number {
  if (words.includes(token)) return weight;
  if (words.some((word) => word.startsWith(token) || token.startsWith(word))) return weight * 0.65;
  return 0;
}

export function searchDocs(
  records: readonly DocsSearchRecord[],
  query: string,
  filters: DocsSearchFilters = {},
  limit = 12,
): DocsSearchResult[] {
  const tokens = expandedTokens(query);
  if (tokens.length === 0) return [];
  const boundedLimit = Math.max(0, Math.trunc(limit));
  if (boundedLimit === 0) return [];
  const ranked: DocsSearchResult[] = [];
  for (const record of records) {
    if (filters.audience && !record.audience.includes(filters.audience)) continue;
    if (filters.productArea && record.productArea !== filters.productArea) continue;
    const titleWords = tokenize(record.title);
    const descriptionWords = tokenize(record.description);
    const keywordWords = tokenize(record.keywords.join(' '));
    const bodyWords = tokenize(record.body);
    let score = 0;
    for (const token of tokens) {
      score += tokenScore(token, titleWords, 12);
      score += tokenScore(token, descriptionWords, 6);
      score += tokenScore(token, keywordWords, 8);
      score += tokenScore(token, bodyWords, 1);
    }
    let bestHeading: DocsSearchRecord['headings'][number] | undefined;
    let headingScore = 0;
    for (const heading of record.headings) {
      const headingWords = tokenize(heading.text);
      const candidate = tokens.reduce(
        (total, token) => total + tokenScore(token, headingWords, 5),
        0,
      );
      if (candidate > headingScore) {
        headingScore = candidate;
        bestHeading = heading;
      }
    }
    score += headingScore;
    if (score > 0) {
      const result: DocsSearchResult = {
        url: bestHeading ? `${record.url}#${bestHeading.id}` : record.url,
        title: record.title,
        description: record.description,
        ...(bestHeading ? { heading: bestHeading } : {}),
        score,
      };
      const insertionIndex = ranked.findIndex(
        (candidate) =>
          result.score > candidate.score ||
          (result.score === candidate.score && result.title.localeCompare(candidate.title) < 0),
      );
      if (insertionIndex === -1) {
        if (ranked.length < boundedLimit) ranked.push(result);
      } else {
        ranked.splice(insertionIndex, 0, result);
        if (ranked.length > boundedLimit) ranked.pop();
      }
    }
  }
  return ranked;
}

export const searchAudiences: readonly Audience[] = [
  'operator',
  'developer',
  'self-hoster',
  'contributor',
];

export const searchProductAreas: readonly ProductArea[] = [
  'platform',
  'workspace',
  'brands',
  'events',
  'inventory',
  'checkout',
  'orders',
  'attendees',
  'check-in',
  'box-office',
  'messaging',
  'reports',
  'team',
  'api',
  'webhooks',
  'sdks',
  'widget',
  'self-hosting',
  'operations',
  'contributing',
];
