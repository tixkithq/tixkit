'use client';

import * as React from 'react';
import type { EmailTemplateDocument } from '@tixkit/content-email';
import { Button } from '@/components/ui/button';

export type EmailCodeViewProps = {
  canEdit: boolean;
  emailDocument: EmailTemplateDocument;
  onCopyHtml: () => void;
  onGlobalCssChange: (css: string) => void;
  onHtmlChange: (html: string) => void;
};

export function EmailCodeView({
  canEdit,
  emailDocument,
  onCopyHtml,
  onGlobalCssChange,
  onHtmlChange,
}: EmailCodeViewProps) {
  return (
    <div className="grid gap-4 rounded-lg bg-zinc-950 p-4 text-xs text-zinc-100 shadow-sm ring-1 ring-border/50">
      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-white">Email HTML</h2>
          <Button
            className="h-8 border-zinc-700 bg-zinc-900 px-3 text-xs text-zinc-100 hover:bg-zinc-800"
            onClick={onCopyHtml}
            type="button"
            variant="outline"
          >
            Copy HTML
          </Button>
        </div>
        <textarea
          aria-label="Email HTML code"
          className="min-h-80 w-full resize-y rounded-md border border-zinc-800 bg-black p-3 font-mono text-xs leading-5 text-zinc-100 outline-none transition focus:border-zinc-500 focus:ring-2 focus:ring-zinc-600 disabled:cursor-not-allowed disabled:opacity-70"
          disabled={!canEdit}
          onChange={(change) => onHtmlChange(change.currentTarget.value)}
          spellCheck={false}
          value={emailDocument.editor.contentHtml}
        />
        <p className="mt-2 text-xs text-zinc-400">
          Edits update the draft HTML. Return to Editor to reload the canvas from this HTML.
        </p>
      </section>
      <details className="group/section">
        <summary className="mb-2 flex cursor-pointer items-center gap-2 text-sm font-semibold text-white">
          <span>Global CSS</span>
          <span className="text-xs font-normal text-zinc-500 group-open/section:hidden">
            (click to expand)
          </span>
        </summary>
        <textarea
          aria-label="Global CSS"
          className="mt-1 min-h-32 w-full resize-y rounded-md border border-zinc-800 bg-black p-3 font-mono text-xs leading-5 text-zinc-100 outline-none transition focus:border-zinc-500 focus:ring-2 focus:ring-zinc-600 disabled:cursor-not-allowed disabled:opacity-70"
          disabled={!canEdit}
          onChange={(change) => onGlobalCssChange(change.currentTarget.value)}
          placeholder=".button { text-transform: uppercase; }"
          spellCheck={false}
          value={emailDocument.editor.globalCss ?? ''}
        />
        <p className="mt-2 text-xs text-zinc-400">
          Injected once into the email HTML head. Validated for unsafe rules before publish.
        </p>
      </details>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-white">Editor JSON</h2>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap leading-5">
          {JSON.stringify(emailDocument.editor.contentJson ?? emailDocument, null, 2)}
        </pre>
      </section>
    </div>
  );
}
