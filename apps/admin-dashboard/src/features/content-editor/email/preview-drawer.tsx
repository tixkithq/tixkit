'use client';

import * as React from 'react';
import { PanelRightClose } from 'lucide-react';

export type EmailEditorPreview = {
  format: 'html' | 'text';
  label: string;
  output: string;
};

export type PreviewDrawerProps = {
  onClose: () => void;
  preview: EmailEditorPreview;
};

export function PreviewDrawer({ onClose, preview }: PreviewDrawerProps) {
  return (
    <aside
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l bg-background text-foreground shadow-2xl"
      data-testid="preview-drawer"
    >
      <div className="flex h-14 items-center justify-between border-b px-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{preview.format}</p>
          <h2 className="text-sm font-semibold">{preview.label}</h2>
        </div>
        <button
          aria-label="Close preview"
          className="inline-flex size-8 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          onClick={onClose}
          type="button"
        >
          <PanelRightClose className="size-4" />
        </button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 text-sm leading-6 text-muted-foreground">
        {preview.output}
      </pre>
    </aside>
  );
}
