'use client';

import * as React from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';

type DataTableV2RowSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ref to the element that had focus before the sheet opened (for restore). */
  focusReturnRef?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  title?: string;
  description?: string;
};

/**
 * Row detail side panel with focus trap and focus restore.
 *
 * Accessibility contracts:
 * - Focus is trapped within the sheet while open.
 * - Focus is restored to the triggering element on close.
 * - Escape closes the sheet (via Radix Dialog).
 * - Works on mobile (390x844) via Radix Sheet responsive sizing.
 */
export function DataTableV2RowSheet({
  open,
  onOpenChange,
  focusReturnRef,
  children,
  title = 'Details',
  description,
}: DataTableV2RowSheetProps) {
  const contentRef = React.useRef<HTMLDivElement | null>(null);

  // Restore focus when sheet closes
  React.useEffect(() => {
    if (!open && focusReturnRef?.current) {
      // Small delay to let Radix finish its cleanup
      requestAnimationFrame(() => {
        focusReturnRef.current?.focus();
      });
    }
  }, [open, focusReturnRef]);

  // Focus first focusable element when sheet opens
  React.useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      const content = contentRef.current;
      if (!content) return;
      const focusable = content.querySelector<HTMLElement>(
        'button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      focusable?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={contentRef}
        side="right"
        className="w-full sm:max-w-lg overflow-y-auto"
        aria-label={title}
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
