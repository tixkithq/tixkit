declare module '*.mdx' {
  import type { ComponentType } from 'react';
  import type { PublicDocFrontmatter } from '@tixkit/docs-core';

  export const frontmatter: PublicDocFrontmatter;
  const MDXContent: ComponentType;
  export default MDXContent;
}
