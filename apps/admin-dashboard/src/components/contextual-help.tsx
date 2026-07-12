'use client';

import { filterHelpByPermissions, helpForPath } from '@tixkit/docs-core';
import { CircleHelp } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { usePermissions } from '@/context/permission-provider';
import { dashboardDocUrl } from '@/lib/docs';

export function ContextualHelp() {
  const pathname = usePathname();
  const { permissions, loading } = usePermissions();
  const match = helpForPath(pathname);
  const entry = match ? filterHelpByPermissions([match], new Set(permissions))[0] : undefined;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  useEffect(() => setOpen(false), [pathname]);

  if (loading || !entry) return null;

  return (
    <div ref={containerRef} className="relative ml-auto">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        className="flex cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen((value) => !value)}
      >
        <CircleHelp className="size-4" aria-hidden="true" />
        Help
      </button>
      {open ? (
        <dialog
          open
          ref={panelRef}
          id={panelId}
          aria-labelledby={`${panelId}-title`}
          tabIndex={-1}
          className="absolute right-0 z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] space-y-4 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div>
            <h2 id={`${panelId}-title`} className="font-semibold">
              {entry.title}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{entry.summary}</p>
          </div>
          <a
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            href={dashboardDocUrl(entry.docRouteId)}
          >
            Open full guide
          </a>
          {entry.commonTasks.length > 0 ? (
            <section aria-labelledby={`context-help-tasks-${entry.id}`}>
              <h3 id={`context-help-tasks-${entry.id}`} className="text-sm font-semibold">
                Common tasks
              </h3>
              <ul className="mt-2 space-y-1">
                {entry.commonTasks.map((task) => (
                  <li key={task.label}>
                    <a
                      className="text-sm text-primary underline-offset-4 hover:underline"
                      href={dashboardDocUrl(task.docRouteId)}
                    >
                      {task.label}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {entry.troubleshooting.length > 0 ? (
            <section aria-labelledby={`context-help-trouble-${entry.id}`}>
              <h3 id={`context-help-trouble-${entry.id}`} className="text-sm font-semibold">
                Troubleshooting
              </h3>
              <ul className="mt-2 space-y-1">
                {entry.troubleshooting.map((item) => (
                  <li key={item.symptom}>
                    <a
                      className="text-sm text-primary underline-offset-4 hover:underline"
                      href={dashboardDocUrl(item.docRouteId)}
                    >
                      {item.symptom}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </dialog>
      ) : null}
    </div>
  );
}
