'use client';

import * as React from 'react';
import { ChevronDown, FileText, Image, Layers, Variable } from 'lucide-react';
import type { EmailEditorRef } from '@react-email/editor';
import type { SlashCommandItem } from '@react-email/editor/ui';
import type { JSONContent } from '@tiptap/core';
import type { EmailVariablePresentation } from '../email-editor-extensions';
import {
  insertEmailComponent,
  insertEmailImage,
  insertMergeTag,
  removeEmailImageBySrc,
  replaceEmailImageSrc,
} from '../email-editor-extensions';

export type EmailVariablePaletteItem = EmailVariablePresentation & {
  key: string;
};

export type InsertPaletteProps = {
  components: SlashCommandItem[];
  disabled: boolean;
  editorRef: React.RefObject<EmailEditorRef | null>;
  variables: EmailVariablePaletteItem[];
  onInsert?: () => void;
  onUploadImage: (file: File) => Promise<{ url: string }>;
};

type PalettePopover = 'text' | 'image' | 'components' | 'variables' | null;

const textItems: Array<{ label: string; content: JSONContent }> = [
  { label: 'Paragraph', content: { type: 'paragraph', content: [{ type: 'text', text: 'Text' }] } },
  {
    label: 'Heading 1',
    content: { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Heading' }] },
  },
  {
    label: 'Heading 2',
    content: { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading' }] },
  },
  {
    label: 'Heading 3',
    content: { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Heading' }] },
  },
];

function groupedBy<T>(
  items: T[],
  keyForItem: (item: T) => string | undefined,
): Array<{ key: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyForItem(item) || 'Other';
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return Array.from(groups, ([key, groupItems]) => ({ key, items: groupItems }));
}

function paletteButtonClass(active: boolean) {
  return [
    'inline-flex size-8 items-center justify-center rounded-md border text-muted-foreground transition-colors',
    active
      ? 'border-foreground/20 bg-accent text-accent-foreground'
      : 'border-transparent hover:bg-accent hover:text-accent-foreground',
  ].join(' ');
}

function waitForImageLoad(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new window.Image();
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, 5000);
    image.addEventListener('load', () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve(true);
    });
    image.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve(false);
    });
    image.src = src;
  });
}

export function InsertPalette({
  components,
  disabled,
  editorRef,
  variables,
  onInsert,
  onUploadImage,
}: InsertPaletteProps) {
  const [open, setOpen] = React.useState<PalettePopover>(null);
  const [uploading, setUploading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  if (disabled) return null;

  const editor = editorRef.current?.editor;
  const completeInsert = () => {
    setOpen(null);
    onInsert?.();
  };

  const insertText = (content: JSONContent) => {
    editor?.chain().focus().insertContent(content).run();
    completeInsert();
  };

  const uploadImage = async (file: File) => {
    if (!editor) return;
    setUploading(true);
    const previewUrl = URL.createObjectURL(file);
    const alt = file.name.replace(/\.[^.]+$/, '').trim() || 'Email image';
    insertEmailImage(editor, { src: previewUrl, alt, alignment: 'center' });
    try {
      const result = await onUploadImage(file);
      const uploadedImageLoaded = await waitForImageLoad(result.url);
      if (uploadedImageLoaded) {
        replaceEmailImageSrc(editor, previewUrl, result.url);
        URL.revokeObjectURL(previewUrl);
      } else {
        console.error(
          `Uploaded email image could not be loaded by the editor canvas: ${result.url}`,
        );
      }
      completeInsert();
    } catch (error) {
      removeEmailImageBySrc(editor, previewUrl);
      URL.revokeObjectURL(previewUrl);
      throw error;
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const componentGroups = groupedBy(components, (component) => component.category);
  const variableGroups = groupedBy(variables, (item) => item.kind);

  return (
    <div className="relative">
      <div className="flex flex-col items-center gap-1">
        <button
          aria-label="Insert text"
          aria-expanded={open === 'text'}
          className={paletteButtonClass(open === 'text')}
          onClick={() => setOpen(open === 'text' ? null : 'text')}
          type="button"
        >
          <FileText className="size-4" />
        </button>
        <button
          aria-label="Insert image"
          aria-expanded={open === 'image'}
          className={paletteButtonClass(open === 'image')}
          onClick={() => setOpen(open === 'image' ? null : 'image')}
          type="button"
        >
          <Image className="size-4" />
        </button>
        <button
          aria-label="Insert component"
          aria-expanded={open === 'components'}
          className={paletteButtonClass(open === 'components')}
          onClick={() => setOpen(open === 'components' ? null : 'components')}
          type="button"
        >
          <Layers className="size-4" />
        </button>
        <button
          aria-label="Insert variable"
          aria-expanded={open === 'variables'}
          className={paletteButtonClass(open === 'variables')}
          onClick={() => setOpen(open === 'variables' ? null : 'variables')}
          type="button"
        >
          <Variable className="size-4" />
        </button>
      </div>
      {open ? (
        <div className="absolute left-10 bottom-0 z-50 w-72 rounded-md border bg-popover p-2 text-popover-foreground shadow-xl">
          {open === 'text' ? (
            <div className="space-y-1">
              {textItems.map((item) => (
                <button
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  key={item.label}
                  onClick={() => insertText(item.content)}
                  type="button"
                >
                  {item.label}
                  <ChevronDown className="size-3 -rotate-90 text-muted-foreground" />
                </button>
              ))}
            </div>
          ) : null}
          {open === 'image' ? (
            <div className="space-y-2">
              <input
                accept="image/*"
                aria-label="Upload email image"
                className="sr-only"
                disabled={uploading}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) void uploadImage(file);
                }}
                ref={fileInputRef}
                type="file"
              />
              <button
                className="w-full rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                {uploading ? 'Uploading...' : 'Choose image'}
              </button>
            </div>
          ) : null}
          {open === 'components' ? (
            <div className="max-h-80 space-y-3 overflow-auto">
              {componentGroups.map((group) => (
                <div key={group.key}>
                  <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {group.key}
                  </p>
                  <div className="space-y-1">
                    {group.items.map((item) => (
                      <button
                        className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
                        key={`${group.key}-${item.title}`}
                        onClick={() => {
                          if (editor) insertEmailComponent(editor, item);
                          completeInsert();
                        }}
                        type="button"
                      >
                        <span className="mt-0.5 text-muted-foreground">{item.icon}</span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{item.title}</span>
                          {item.description ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              {item.description}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {open === 'variables' ? (
            <div className="max-h-80 space-y-3 overflow-auto">
              {variableGroups.map((group) => (
                <div key={group.key}>
                  <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {group.key}
                  </p>
                  <div className="space-y-1">
                    {group.items.map((item) => (
                      <button
                        className="w-full rounded-md px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
                        key={item.key}
                        onClick={() => {
                          if (editor) insertMergeTag(editor, item.key);
                          completeInsert();
                        }}
                        type="button"
                      >
                        <span className="block text-sm font-medium">{item.label}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {item.preview}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
