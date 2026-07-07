'use client';

import * as React from 'react';
import { Inspector } from '@react-email/editor/ui';

export type EmailThemePreset = 'brand' | 'minimal' | 'basic';

export type StyleInspectorProps = {
  disabled: boolean;
  globalCss: string;
  themePreset: EmailThemePreset;
  onGlobalCssChange: (css: string) => void;
  onThemePresetChange: (preset: EmailThemePreset) => void;
};

const inspectorNodeSectionLayout: Record<string, string[]> = {
  image: ['attributes', 'size', 'link', 'padding', 'border'],
  button: ['link', 'size', 'padding', 'border', 'background'],
  section: ['background', 'padding', 'border'],
  div: ['background', 'padding', 'border'],
  codeBlock: ['attributes', 'padding', 'border'],
  footer: ['padding', 'background'],
  twoColumns: ['columnSpacing', 'padding', 'background', 'border'],
  threeColumns: ['columnSpacing', 'padding', 'background', 'border'],
  fourColumns: ['columnSpacing', 'padding', 'background', 'border'],
};
const inspectorDefaultSections = ['padding', 'background', 'border'];

function inspectorSectionTypesForNode(nodeType: string): string[] {
  return inspectorNodeSectionLayout[nodeType] ?? inspectorDefaultSections;
}

function presetButtonClass(active: boolean) {
  return [
    'rounded-md border px-2.5 py-1.5 text-xs font-medium capitalize transition-colors disabled:opacity-50',
    active
      ? 'border-foreground/20 bg-accent text-accent-foreground'
      : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  ].join(' ');
}

export function StyleInspector({
  disabled,
  globalCss,
  themePreset,
  onGlobalCssChange,
  onThemePresetChange,
}: StyleInspectorProps) {
  const [themeOpen, setThemeOpen] = React.useState(false);
  const [cssOpen, setCssOpen] = React.useState(false);

  return (
    <aside
      aria-label="Email style inspector"
      className="fixed inset-y-[60px] right-0 z-30 hidden w-80 shrink-0 border-l bg-background text-foreground shadow-xl lg:flex xl:w-[22rem]"
      data-testid="native-email-inspector-host"
      data-tixkit-email-inspector="true"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Page style</p>
          <div className="mt-1 text-sm font-semibold text-foreground">
            <Inspector.Breadcrumb />
          </div>
        </div>
        <Inspector.Root aria-label="React Email style inspector">
          <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
            <div className="space-y-5">
              <Inspector.Document />
              <Inspector.Node>
                {(context) => {
                  const sectionTypes = inspectorSectionTypesForNode(context.nodeType);
                  return sectionTypes.map((type) => {
                    switch (type) {
                      case 'attributes':
                        return <Inspector.Attributes key={type} {...context} />;
                      case 'size':
                        return <Inspector.Size key={type} {...context} />;
                      case 'padding':
                        return <Inspector.Padding key={type} {...context} />;
                      case 'columnSpacing':
                        return <Inspector.ColumnSpacing key={type} {...context} />;
                      case 'background':
                        return <Inspector.Background key={type} {...context} />;
                      case 'border':
                        return <Inspector.Border key={type} {...context} />;
                      default:
                        return null;
                    }
                  });
                }}
              </Inspector.Node>
            </div>
          </div>
        </Inspector.Root>
        <div className="space-y-2 border-t p-3">
          <div className="rounded-md border">
            <button
              aria-expanded={themeOpen}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium"
              onClick={() => setThemeOpen((open) => !open)}
              type="button"
            >
              Edit theme
              <span className="text-xs capitalize text-muted-foreground">{themePreset}</span>
            </button>
            {themeOpen ? (
              <div className="flex gap-2 border-t p-3">
                {(['brand', 'minimal', 'basic'] as const).map((preset) => (
                  <button
                    className={presetButtonClass(themePreset === preset)}
                    disabled={disabled}
                    key={preset}
                    onClick={() => onThemePresetChange(preset)}
                    type="button"
                  >
                    {preset}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="rounded-md border">
            <button
              aria-expanded={cssOpen}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium"
              onClick={() => setCssOpen((open) => !open)}
              type="button"
            >
              Global CSS
              <span className="text-xs text-muted-foreground">{globalCss.trim() ? 'Custom' : 'None'}</span>
            </button>
            {cssOpen ? (
              <div className="border-t p-3">
                <textarea
                  aria-label="Global CSS"
                  className="min-h-28 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                  disabled={disabled}
                  onChange={(event) => onGlobalCssChange(event.currentTarget.value)}
                  placeholder=".email-root { }"
                  value={globalCss}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Scoped CSS is applied to rendered email HTML before preview, test, and publish.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </aside>
  );
}
