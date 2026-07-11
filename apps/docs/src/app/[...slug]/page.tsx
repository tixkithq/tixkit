import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocPage } from '@/components/doc-page';
import { contentManifest } from '@/generated/content-manifest';
import { docsSiteConfig } from '@/lib/site';

interface PageProps {
  params: Promise<{ slug: string[] }>;
}

function routeFor(slug: readonly string[]) {
  return `/${slug.join('/')}`;
}

export function generateStaticParams() {
  return Object.keys(contentManifest).map((route) => ({ slug: route.split('/').filter(Boolean) }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const route = routeFor((await params).slug);
  const entry = contentManifest[route as keyof typeof contentManifest];
  if (!entry) return {};
  return {
    title: entry.frontmatter.title,
    description: entry.frontmatter.description,
    alternates: { canonical: route },
    openGraph: {
      title: entry.frontmatter.title,
      description: entry.frontmatter.description,
      url: route,
      type: 'article',
    },
  };
}

export default async function DocumentationPage({ params }: PageProps) {
  const route = routeFor((await params).slug);
  const entry = contentManifest[route as keyof typeof contentManifest];
  if (!entry) notFound();
  const module = await entry.load();
  const Content = module.default;
  return (
    <DocPage
      route={route}
      sourcePath={entry.sourcePath}
      frontmatter={entry.frontmatter}
      headings={entry.headings}
      repositoryUrl={docsSiteConfig().repositoryUrl}
    >
      <Content />
    </DocPage>
  );
}
