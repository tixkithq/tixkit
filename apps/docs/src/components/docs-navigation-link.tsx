'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function DocsNavigationLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  return (
    <Link href={href} prefetch={false} aria-current={pathname === href ? 'page' : undefined}>
      {label}
    </Link>
  );
}
