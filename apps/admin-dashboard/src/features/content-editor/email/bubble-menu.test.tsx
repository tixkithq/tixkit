import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TixkitEmailBubbleMenu } from './bubble-menu';

const editorState = vi.hoisted(() => ({
  href: 'https://example.test/event',
}));

vi.mock('@tiptap/react', () => {
  const dom = document.createElement('div');
  return {
    useCurrentEditor: () => ({
      editor: {
        commands: {},
        extensionStorage: {},
        getAttributes: (name: string) => (name === 'image' ? { href: editorState.href } : {}),
        isActive: (name: string) => name === 'image',
        view: {
          dom,
          hasFocus: () => true,
          state: {
            selection: {
              content: () => ({ size: 0 }),
              empty: true,
              $from: { depth: 0, parent: { content: { size: 0 }, inlineContent: false } },
            },
          },
        },
      },
    }),
    useEditorState: ({
      editor,
      selector,
    }: {
      editor: unknown;
      selector: (context: { editor: unknown }) => unknown;
    }) => selector({ editor }),
  };
});

vi.mock('@react-email/editor/ui', () => {
  return {
    AlignCenterIcon: () => <span>Center</span>,
    AlignLeftIcon: () => <span>Left</span>,
    AlignRightIcon: () => <span>Right</span>,
    BubbleMenu: {
      Bold: () => null,
      Code: () => null,
      ImageEditLink: () => <button type="button">Edit link</button>,
      ImageForm: () => <input aria-label="Image click-through link" />,
      ImageToolbar: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
      ImageUnlink: () => <button type="button">Remove link</button>,
      Item: ({ children, name }: React.PropsWithChildren<{ name: string }>) => (
        <button aria-label={name} type="button">
          {children}
        </button>
      ),
      ItemGroup: ({ children }: React.PropsWithChildren) => <fieldset>{children}</fieldset>,
      Italic: () => null,
      LinkSelector: () => null,
      NodeSelector: () => null,
      Strike: () => null,
      Underline: () => null,
      Uppercase: () => null,
    },
  };
});

describe('TixkitEmailBubbleMenu', () => {
  it('keeps image click-through link editing beside image alignment controls', () => {
    render(<TixkitEmailBubbleMenu />);

    expect(screen.getByRole('button', { name: 'Edit link' })).toBeInTheDocument();
    expect(screen.getByLabelText('Image click-through link')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Align left' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Align center' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Align right' })).toBeInTheDocument();
  });
});
