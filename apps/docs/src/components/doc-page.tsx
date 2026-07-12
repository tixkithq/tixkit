import type { PublicDocFrontmatter } from '@tixkit/docs-core';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { contentManifest } from '@/generated/content-manifest';

interface Heading {
  id: string;
  text: string;
  level: 2 | 3;
}

function breadcrumbs(route: string, canonicalRoutes: ReadonlySet<string>) {
  const segments = route.split('/').filter(Boolean);
  return segments.map((segment, index) => ({
    label: segment.replaceAll('-', ' '),
    href: canonicalRoutes.has(`/${segments.slice(0, index + 1).join('/')}`)
      ? `/${segments.slice(0, index + 1).join('/')}`
      : undefined,
  }));
}

export function DocPage({
  children,
  route,
  sourcePath,
  frontmatter,
  headings,
  repositoryUrl,
}: {
  children: ReactNode;
  route: string;
  sourcePath: string;
  frontmatter: PublicDocFrontmatter;
  headings: readonly Heading[];
  repositoryUrl: string;
}) {
  const routes = Object.keys(contentManifest);
  const canonicalRoutes = new Set(routes);
  const index = routes.indexOf(route);
  const previous =
    index > 0 ? contentManifest[routes[index - 1] as keyof typeof contentManifest] : undefined;
  const next =
    index >= 0 && index < routes.length - 1
      ? contentManifest[routes[index + 1] as keyof typeof contentManifest]
      : undefined;
  const editUrl = `${repositoryUrl}/edit/main/${sourcePath}`;
  const issue = new URL(`${repositoryUrl}/issues/new`);
  issue.searchParams.set('title', `Documentation: ${frontmatter.title}`);
  issue.searchParams.set(
    'body',
    `Page: ${route}\nSource: ${sourcePath}\n\nWhat is incorrect, missing, or unclear?\n`,
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <ol>
          <li>
            <Link href="/" prefetch={false}>
              Docs
            </Link>
          </li>
          {breadcrumbs(route, canonicalRoutes).map((item, itemIndex, items) => (
            <li key={`${item.label}-${itemIndex}`}>
              {itemIndex === items.length - 1 ? (
                <span aria-current="page">{item.label}</span>
              ) : item.href ? (
                <Link href={item.href} prefetch={false}>
                  {item.label}
                </Link>
              ) : (
                <span>{item.label}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <div className="doc-grid">
        <article className="doc-article">
          <header className="doc-title">
            <div className="doc-badges">
              <span>{frontmatter.status}</span>
              {frontmatter.audience.map((value) => (
                <span key={value}>{value}</span>
              ))}
            </div>
            <h1>{frontmatter.title}</h1>
            <p>{frontmatter.description}</p>
          </header>
          {headings.length > 0 ? (
            <details className="mobile-table-of-contents">
              <summary>On this page</summary>
              <nav aria-label="On this page">
                <ol>
                  {headings.map((heading) => (
                    <li key={heading.id} data-level={heading.level}>
                      <a href={`#${heading.id}`}>{heading.text}</a>
                    </li>
                  ))}
                </ol>
              </nav>
            </details>
          ) : null}
          <div className="prose">{children}</div>
          <footer className="doc-footer">
            <p>
              Last verified{' '}
              <time dateTime={frontmatter.last_verified}>{frontmatter.last_verified}</time> · Owned
              by {frontmatter.owner}
            </p>
            <div>
              <a href={editUrl}>Edit this page</a>
              <a href={issue.toString()}>Report a documentation issue</a>
            </div>
            {frontmatter.related.length > 0 ? (
              <section>
                <h2>Related pages</h2>
                <ul>
                  {frontmatter.related.map((path) => (
                    <li key={path}>
                      <Link href={path} prefetch={false}>
                        {contentManifest[path as keyof typeof contentManifest]?.frontmatter.title ??
                          path}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </footer>
          <nav className="previous-next" aria-label="Previous and next documentation">
            {previous ? (
              <Link href={routes[index - 1]!} prefetch={false}>
                ← {previous.frontmatter.title}
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link href={routes[index + 1]!} prefetch={false}>
                {next.frontmatter.title} →
              </Link>
            ) : null}
          </nav>
        </article>
        {headings.length > 0 ? (
          <aside className="table-of-contents" aria-label="Page contents">
            <nav aria-label="On this page">
              <strong>On this page</strong>
              <ol>
                {headings.map((heading) => (
                  <li key={heading.id} data-level={heading.level}>
                    <a href={`#${heading.id}`}>{heading.text}</a>
                  </li>
                ))}
              </ol>
            </nav>
          </aside>
        ) : null}
      </div>
    </>
  );
}
