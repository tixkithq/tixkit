"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { docRoutes } from "@tixkit/docs-core";
import {
  documentationNavigation,
  type DocumentationNavigationItem,
} from "../../../../docs/navigation";

function NavigationItems({
  items,
  pathname,
  onNavigate,
}: {
  items: readonly DocumentationNavigationItem[];
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <ul>
      {items.map((item) => (
        <li key={`${item.label}-${item.routeId ?? "group"}`}>
          {item.routeId ? (
            <Link
              href={docRoutes[item.routeId]}
              prefetch={false}
              aria-current={
                pathname === docRoutes[item.routeId] ? "page" : undefined
              }
              onClick={onNavigate}
            >
              {item.label}
            </Link>
          ) : (
            <span>{item.label}</span>
          )}
          {item.children ? (
            <NavigationItems
              items={item.children}
              pathname={pathname}
              onNavigate={onNavigate}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function DocsNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <NavigationItems
      items={documentationNavigation}
      pathname={pathname}
      onNavigate={onNavigate}
    />
  );
}
