const DEFAULT_SITE_URL = 'http://localhost:3002';
const DEFAULT_REPOSITORY_URL = 'https://github.com/tixkit/tixkit';
const DEFAULT_API_BASE_URL = 'http://localhost:4000';

function httpUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials`);
  }
  return url.toString().replace(/\/$/, '');
}

export interface DocsSiteConfig {
  siteUrl: string;
  repositoryUrl: string;
  apiBaseUrl: string;
  version: string;
  commit: string;
}

export function docsSiteConfig(): DocsSiteConfig {
  return {
    siteUrl: httpUrl('TIXKIT_DOCS_SITE_URL', process.env.TIXKIT_DOCS_SITE_URL ?? DEFAULT_SITE_URL),
    repositoryUrl: httpUrl(
      'TIXKIT_DOCS_REPOSITORY_URL',
      process.env.TIXKIT_DOCS_REPOSITORY_URL ?? DEFAULT_REPOSITORY_URL,
    ),
    apiBaseUrl: httpUrl(
      'TIXKIT_DOCS_DEFAULT_API_BASE_URL',
      process.env.TIXKIT_DOCS_DEFAULT_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    ),
    version: process.env.TIXKIT_DOCS_VERSION?.trim() || 'current',
    commit: process.env.TIXKIT_BUILD_COMMIT?.trim() || 'development',
  };
}
