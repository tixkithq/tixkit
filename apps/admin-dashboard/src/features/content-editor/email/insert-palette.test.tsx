import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { SlashCommandItem } from '@react-email/editor/ui';
import { InsertPalette, type EmailVariablePaletteItem } from './insert-palette';
import { insertEmailComponent, insertMergeTag } from '../email-editor-extensions';

vi.mock('../email-editor-extensions', () => ({
  insertEmailComponent: vi.fn(),
  insertMergeTag: vi.fn(),
}));

const editor = {
  chain: vi.fn(() => ({
    focus: vi.fn(() => ({
      insertContent: vi.fn(() => ({ run: vi.fn() })),
    })),
  })),
};

const editorRef = {
  current: {
    editor,
  },
} as unknown as React.RefObject<import('@react-email/editor').EmailEditorRef | null>;

const components: SlashCommandItem[] = [
  {
    title: 'Ticket summary',
    description: 'Ticket type and order total',
    category: 'Tixkit',
    icon: React.createElement('span'),
    searchTerms: ['ticket'],
    command: vi.fn(),
  },
  {
    title: 'HTML',
    description: 'Insert an HTML code block',
    category: 'Advanced',
    icon: React.createElement('span'),
    searchTerms: ['html'],
    command: vi.fn(),
  },
];

const variables: EmailVariablePaletteItem[] = [
  {
    key: 'recipient.name',
    label: 'Attendee name',
    preview: 'Ada Lovelace',
    kind: 'recipient',
  },
  {
    key: 'event.title',
    label: 'Event name',
    preview: 'Sample Summer Showcase',
    kind: 'event',
  },
];

function renderPalette(options: { disabled?: boolean; onInsert?: () => void } = {}) {
  return render(
    <InsertPalette
      components={components}
      disabled={options.disabled ?? false}
      editorRef={editorRef}
      onInsert={options.onInsert}
      onUploadImage={vi.fn(async () => ({ url: 'https://assets.example.test/image.png' }))}
      variables={variables}
    />,
  );
}

describe('InsertPalette', () => {
  it('hides when disabled', () => {
    renderPalette({ disabled: true });

    expect(screen.queryByLabelText('Insert text')).not.toBeInTheDocument();
  });

  it('lists text insertion options', () => {
    renderPalette();

    fireEvent.click(screen.getByLabelText('Insert text'));

    expect(screen.getByRole('button', { name: 'Paragraph' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Heading 1' })).toBeInTheDocument();
  });

  it('lists component groups and dispatches component insertion', () => {
    const onInsert = vi.fn();
    renderPalette({ onInsert });

    fireEvent.click(screen.getByLabelText('Insert component'));
    fireEvent.click(screen.getByRole('button', { name: /Ticket summary/ }));

    expect(insertEmailComponent).toHaveBeenCalledWith(editor, components[0]);
    expect(onInsert).toHaveBeenCalled();
  });

  it('lists variables and dispatches merge-tag insertion', () => {
    const onInsert = vi.fn();
    renderPalette({ onInsert });

    fireEvent.click(screen.getByLabelText('Insert variable'));
    fireEvent.click(screen.getByRole('button', { name: /Attendee name/ }));

    expect(insertMergeTag).toHaveBeenCalledWith(editor, 'recipient.name');
    expect(onInsert).toHaveBeenCalled();
  });
});
