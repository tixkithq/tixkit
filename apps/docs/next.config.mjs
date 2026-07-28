import { resolve } from 'node:path';
import createMDX from '@next/mdx';

const staticExport = process.env.TIXKIT_DOCS_STATIC_EXPORT === '1';
const repositoryRoot = resolve(import.meta.dirname, '../..');

const withMDX = createMDX({
  extension: /\.mdx?$/,
  options: {
    remarkPlugins: [
      'remark-frontmatter',
      ['remark-mdx-frontmatter', { name: 'frontmatter' }],
      'remark-gfm',
    ],
  },
});

const nextConfig = {
  output: staticExport ? 'export' : 'standalone',
  outputFileTracingRoot: repositoryRoot,
  pageExtensions: ['ts', 'tsx', 'md', 'mdx'],
  reactStrictMode: true,
  trailingSlash: staticExport,
  experimental: { useTypeScriptCli: true },
  transpilePackages: ['@tixkit/docs-core'],
  typescript: { ignoreBuildErrors: true },
  turbopack: {
    root: repositoryRoot,
  },
  ...(staticExport
    ? {}
    : {
        async redirects() {
          const { default: redirects } = await import('../../docs/redirects.json', {
            with: { type: 'json' },
          });
          return Object.entries(redirects).map(([source, destination]) => ({
            source,
            destination,
            permanent: true,
          }));
        },
      }),
};

export default withMDX(nextConfig);
