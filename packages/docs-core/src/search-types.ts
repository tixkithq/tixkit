import type {
  AdoptionPath,
  Audience,
  ContentStatus,
  ContentType,
  ProductArea,
} from './content-schema.js';

export interface DocsSearchHeading {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface DocsSearchRecord {
  url: string;
  title: string;
  description: string;
  headings: readonly DocsSearchHeading[];
  body: string;
  audience: readonly Audience[];
  productArea: ProductArea;
  contentType: ContentType;
  status: Exclude<ContentStatus, 'internal'>;
  keywords: readonly string[];
  adoptionPaths: readonly AdoptionPath[];
}

export interface DocsSearchFilters {
  audience?: Audience;
  productArea?: ProductArea;
  adoptionPath?: AdoptionPath;
}

export interface DocsSearchResult {
  url: string;
  title: string;
  description: string;
  heading?: DocsSearchHeading;
  score: number;
}
