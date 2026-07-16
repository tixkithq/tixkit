import { docRoutes } from '@tixkit/docs-core';
import {
  documentationNavigation,
  type DocumentationNavigationItem,
} from '../../../../docs/navigation';
import { DocsNavigationLink } from './docs-navigation-link';

function NavigationItems({ items }: { items: readonly DocumentationNavigationItem[] }) {
  return (
    <ul>
      {items.map((item) => (
        <li key={`${item.label}-${item.routeId ?? 'group'}`}>
          {item.routeId ? (
            <DocsNavigationLink href={docRoutes[item.routeId]} label={item.label} />
          ) : (
            <span>{item.label}</span>
          )}
          {item.children ? <NavigationItems items={item.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

export function DocsNavigation() {
  return <NavigationItems items={documentationNavigation} />;
}
