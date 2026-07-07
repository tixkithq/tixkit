'use client';

import * as React from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import Heading from '@tiptap/extension-heading';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { type JSONContent } from '@tiptap/core';
import {
  EventPageInlineStyle,
  EventPageTextAlignment,
  EVENT_PAGE_FONT_FAMILY_OPTIONS,
  type EventPageBlock,
} from '@tixkit/content-event-page';

type RichTextBlock = Extract<EventPageBlock, { type: 'rich_text' }>;

export type EventPageRichTextEditorProps = {
  block: RichTextBlock;
  disabled: boolean;
  onChange: (block: EventPageBlock) => void;
};

/**
 * Bubble menu toolbar for the event-page rich text editor.
 * Provides bold/italic/strike toggles, font family selection,
 * text alignment, and link insertion when text is selected.
 */
function RichTextBubbleMenu({ editor }: { editor: Editor }) {
  const setFontFamily = (value: string) => {
    if (value) {
      editor.chain().focus().setMark(EventPageInlineStyle.name, { fontFamily: value }).run();
    } else {
      editor.chain().focus().unsetMark(EventPageInlineStyle.name).run();
    }
  };

  const setAlignment = (alignment: 'left' | 'center' | 'right') => {
    const nodeType = editor.state.selection.$from.parent.type.name;
    editor.chain().focus().updateAttributes(nodeType, { textAlign: alignment }).run();
  };

  const toggleLink = () => {
    const previousUrl = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL', previousUrl ?? 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor.chain().focus().toggleLink({ href: url }).run();
  };

  const currentFontFamily = (editor.getAttributes(EventPageInlineStyle.name).fontFamily as string) ?? '';
  const currentAlignment = (editor.getAttributes('paragraph').textAlign as string) ??
    (editor.getAttributes('heading').textAlign as string) ?? 'left';

  return (
    <BubbleMenu
      editor={editor}
      className="tk-ep-bubble"
    >
      <button
        type="button"
        className="tk-ep-bubble__btn"
        aria-label="Bold"
        aria-pressed={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        B
      </button>
      <button
        type="button"
        className="tk-ep-bubble__btn"
        aria-label="Italic"
        aria-pressed={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        I
      </button>
      <button
        type="button"
        className="tk-ep-bubble__btn"
        aria-label="Strikethrough"
        aria-pressed={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        S
      </button>
      <span className="tk-ep-bubble__divider" />
      <select
        className="tk-ep-bubble__select"
        value={currentFontFamily}
        onChange={(e) => setFontFamily(e.target.value)}
        aria-label="Selection font family"
      >
        {EVENT_PAGE_FONT_FAMILY_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <span className="tk-ep-bubble__divider" />
      <button
        type="button"
        className="tk-ep-bubble__btn"
        aria-label="Align left"
        aria-pressed={currentAlignment === 'left'}
        onClick={() => setAlignment('left')}
      >
        ⬅
      </button>
      <button
        type="button"
        className="tk-ep-bubble__btn"
        aria-label="Align center"
        aria-pressed={currentAlignment === 'center'}
        onClick={() => setAlignment('center')}
      >
        ⬌
      </button>
      <button
        type="button"
        className="tk-ep-bubble__btn"
        aria-label="Align right"
        aria-pressed={currentAlignment === 'right'}
        onClick={() => setAlignment('right')}
      >
        ➡
      </button>
      <span className="tk-ep-bubble__divider" />
      <button
        type="button"
        className="tk-ep-bubble__btn"
        aria-label="Link"
        aria-pressed={editor.isActive('link')}
        onClick={toggleLink}
      >
        🔗
      </button>
    </BubbleMenu>
  );
}

/**
 * TipTap-based WYSIWYG editor for rich_text event-page blocks.
 * Renders the block's JSONContent with the event-page inline style and
 * text alignment extensions, calling onChange on every update.
 * Includes a bubble menu for inline formatting (bold/italic/strike,
 * font family, text alignment, link).
 */
export function EventPageRichTextEditor({
  block,
  disabled,
  onChange,
}: EventPageRichTextEditorProps) {
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    editorProps: {
      attributes: {
        'aria-label': 'Rich text content',
      },
    },
    extensions: [
      StarterKit.configure({
        heading: false,
      }),
      Heading.configure({
        levels: [1, 2, 3],
      }),
      Image,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer' },
      }),
      EventPageInlineStyle,
      EventPageTextAlignment,
    ],
    content: block.content as JSONContent,
    editable: !disabled,
    onUpdate: ({ editor: ed }) => {
      const content = ed.getJSON();
      onChangeRef.current({ ...block, content });
    },
  });

  React.useEffect(() => {
    if (editor) {
      editor.setEditable(!disabled);
    }
  }, [editor, disabled]);

  if (!editor) {
    return (
      <div className="tk-ep-rich-text__content" data-placeholder="Loading editor..." />
    );
  }

  return (
    <>
      <RichTextBubbleMenu editor={editor} />
      <EditorContent
        editor={editor}
        className="tk-ep-rich-text__content"
        aria-label="Rich text content"
      />
    </>
  );
}
