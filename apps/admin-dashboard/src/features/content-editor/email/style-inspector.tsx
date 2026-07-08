'use client';

import { Inspector } from '@react-email/editor/ui';

export type EmailThemePreset = 'brand' | 'minimal' | 'basic';

export type StyleInspectorProps = Record<string, never>;

const inspectorNodeSectionLayout: Record<string, string[]> = {
  image: ['attributes', 'size', 'link', 'padding', 'background', 'border'],
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

export function StyleInspector(_props: StyleInspectorProps) {
  return (
    <aside
      aria-label="Email style inspector"
      className="fixed bottom-0 right-0 top-[60px] z-30 hidden w-80 shrink-0 border-l bg-background text-foreground shadow-xl lg:flex xl:w-[22rem]"
      data-testid="native-email-inspector-host"
      data-tixkit-email-inspector="true"
    >
      <Inspector.Root aria-label="React Email style inspector" className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Page style</p>
            <div className="mt-1 text-sm font-semibold text-foreground">
              <Inspector.Breadcrumb />
            </div>
          </div>
          <div
            className="min-h-0 flex-1 overflow-auto px-5 py-5 pr-6"
            style={{ scrollbarGutter: 'stable' }}
          >
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
        </div>
      </Inspector.Root>
    </aside>
  );
}
