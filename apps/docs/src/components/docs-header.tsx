import Link from 'next/link';
import { DocsNavigation } from './docs-navigation';
import { MobileDocsNavigation } from './mobile-docs-navigation';
import { SearchDialog } from './search-dialog';
import { ThemeToggle } from './theme-toggle';

export function DocsHeader({ repositoryUrl, version }: { repositoryUrl: string; version: string }) {
  return (
    <header className="site-header">
      <div className="site-header__bar">
        <Link className="wordmark" href="/" aria-label="Tixkit documentation home">
          Tixkit <span>Docs</span>
        </Link>
        <span className="version" aria-label={`Documentation version ${version}`}>
          {version}
        </span>
        <SearchDialog />
        <ThemeToggle />
        <a href={repositoryUrl} rel="noreferrer">
          Repository
        </a>
        <MobileDocsNavigation>
          <DocsNavigation />
        </MobileDocsNavigation>
      </div>
    </header>
  );
}
