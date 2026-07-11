'use client';

import { Children, isValidElement, type ReactNode, useState } from 'react';

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children);
  return Children.toArray(node).map(textContent).join('');
}

export function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = textContent(children).replace(/\n$/, '');

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="code-block">
      <button type="button" onClick={() => void copy()} aria-label="Copy code">
        Copy
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Code copied' : ''}
      </span>
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 requires keyboard access to horizontally scrollable code. */}
      <pre tabIndex={0}>{children}</pre>
    </div>
  );
}
