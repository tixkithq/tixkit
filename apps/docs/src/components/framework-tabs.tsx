'use client';

import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { CodeBlock } from './code-block';

export interface FrameworkTab {
  label: string;
  code: string;
  language?: string;
}

export function FrameworkTabs({ tabs }: { tabs: readonly FrameworkTab[] }) {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  if (tabs.length === 0) return null;
  function selectTab(index: number) {
    const normalized = (index + tabs.length) % tabs.length;
    setActive(normalized);
    tabRefs.current[normalized]?.focus();
  }
  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const nextIndex =
      event.key === 'ArrowRight'
        ? index + 1
        : event.key === 'ArrowLeft'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : null;
    if (nextIndex === null) return;
    event.preventDefault();
    selectTab(nextIndex);
  }
  return (
    <div className="framework-tabs">
      <div role="tablist" aria-label="Framework examples">
        {tabs.map((tab, index) => (
          <button
            key={tab.label}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            id={`${id}-tab-${index}`}
            role="tab"
            type="button"
            aria-selected={active === index}
            aria-controls={`${id}-panel-${index}`}
            tabIndex={active === index ? 0 : -1}
            onClick={() => setActive(index)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab, index) => (
        <div
          key={tab.label}
          id={`${id}-panel-${index}`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${index}`}
          hidden={active !== index}
        >
          <CodeBlock>
            <code className={tab.language ? `language-${tab.language}` : undefined}>
              {tab.code}
            </code>
          </CodeBlock>
        </div>
      ))}
      <noscript>
        {tabs.map((tab) => (
          <pre key={tab.label}>
            <strong>{tab.label}</strong>
            {'\n'}
            {tab.code}
          </pre>
        ))}
      </noscript>
    </div>
  );
}
