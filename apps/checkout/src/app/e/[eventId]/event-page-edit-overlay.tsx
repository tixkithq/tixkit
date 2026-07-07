'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircleIcon,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import {
  publicApi,
  CheckoutApiError,
  type DraftPreviewPage,
  userFacingMessage,
} from '@/lib/api';
import { brandThemeStyle, type ResolvedBrand } from '@/lib/brand';
import { useResolvedBrand } from '@/lib/use-brand';
import {
  EventPageEditorSurface,
} from '@tixkit/content-event-page-react';
import {
  normalizeEventPageDocument,
  type EventPageBlock,
  type EventPageDocument,
  type EventPageRenderContext,
} from '@tixkit/content-event-page';
import { EventPageRichTextEditor } from '@/components/event-page-rich-text-editor';

const EDITOR_SOURCE = 'tixkit-event-page-editor';
const PARENT_SOURCE = 'tixkit-event-page-admin';

type EditorToParentMessage =
  | { source: typeof EDITOR_SOURCE; type: 'ready' }
  | { source: typeof EDITOR_SOURCE; type: 'selection-change'; blockId: string }
  | {
      source: typeof EDITOR_SOURCE;
      type: 'block-change';
      blockId: string;
      block: EventPageBlock;
    }
  | {
      source: typeof EDITOR_SOURCE;
      type: 'blocks-reorder';
      blocks: EventPageBlock[];
    }
  | {
      source: typeof EDITOR_SOURCE;
      type: 'block-delete';
      blockId: string;
    }
  | {
      source: typeof EDITOR_SOURCE;
      type: 'block-duplicate';
      blockId: string;
    };

type ParentToEditorMessage =
  | { source: typeof PARENT_SOURCE; type: 'select-block'; blockId: string }
  | {
      source: typeof PARENT_SOURCE;
      type: 'update-block';
      blockId: string;
      block: EventPageBlock;
    }
  | {
      source: typeof PARENT_SOURCE;
      type: 'update-document';
      document: EventPageDocument;
      selectedBlockId?: string;
    }
  | { source: typeof PARENT_SOURCE; type: 'reload'; token: string };

function isParentToEditorMessage(value: unknown): value is ParentToEditorMessage {
  if (!value || typeof value !== 'object') return false;
  const msg = value as Record<string, unknown>;
  return msg.source === PARENT_SOURCE && typeof msg.type === 'string';
}

function parentOriginAllowlist(): string[] {
  const raw = process.env.NEXT_PUBLIC_ADMIN_ORIGIN?.trim();
  if (!raw) return [];
  return raw.split(',').map((o) => o.trim()).filter(Boolean);
}

function isAllowedParentOrigin(origin: string): boolean {
  const allowlist = parentOriginAllowlist();
  if (allowlist.length === 0) return true;
  return allowlist.includes(origin);
}

type Props = {
  eventId: string;
  token: string;
  brandId?: string;
};

export default function EventPageEditOverlay({ eventId, token, brandId }: Props) {
  const [draft, setDraft] = useState<DraftPreviewPage | null>(null);
  const [document, setDocument] = useState<EventPageDocument | null>(null);
  const [context, setContext] = useState<EventPageRenderContext | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const suppressChangeRef = useRef(false);
  const tokenRef = useRef(token);

  const brand: ResolvedBrand = useResolvedBrand(
    useMemo(
      () => ({
        brandId: brandId,
      }),
      [brandId],
    ),
  );

  const loadDraft = useCallback(
    async (loadToken: string, signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const result = await publicApi.getDraftPreview(eventId, loadToken, signal);
        const normalized = normalizeEventPageDocument(result.contentJson);
        if (!normalized) {
          setError('Draft is not a valid event-page document.');
          setLoading(false);
          return;
        }
        setDraft(result);
        setDocument(normalized);
        setContext(result.context as EventPageRenderContext);
        setSelectedBlockId(normalized.blocks[0]?.id);
        setLoading(false);
      } catch (err) {
        if (signal?.aborted) return;
        const notFound = err instanceof CheckoutApiError && err.status === 404;
        setError(
          notFound
            ? 'Preview token is invalid or expired. Refresh the editor.'
            : userFacingMessage(err),
        );
        setLoading(false);
      }
    },
    [eventId],
  );

  useEffect(() => {
    tokenRef.current = token;
    const controller = new AbortController();
    void loadDraft(token, controller.signal);
    return () => controller.abort();
  }, [loadDraft, token]);

  const sendMessage = useCallback((message: EditorToParentMessage) => {
    if (window.parent !== window) {
      window.parent.postMessage(message, '*');
    }
  }, []);

  useEffect(() => {
    if (!loading && document) {
      sendMessage({ source: EDITOR_SOURCE, type: 'ready' });
    }
  }, [loading, document, sendMessage]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!isAllowedParentOrigin(event.origin)) return;
      if (!isParentToEditorMessage(event.data)) return;
      const message = event.data as ParentToEditorMessage;
      switch (message.type) {
        case 'select-block':
          setSelectedBlockId(message.blockId);
          break;
        case 'update-block':
          if (!document) return;
          suppressChangeRef.current = true;
          setDocument({
            ...document,
            blocks: document.blocks.map((b) =>
              b.id === message.blockId ? message.block : b,
            ),
          });
          break;
        case 'update-document':
          suppressChangeRef.current = true;
          setDocument(message.document);
          setSelectedBlockId(
            message.selectedBlockId ?? message.document.blocks[0]?.id,
          );
          break;
        case 'reload':
          tokenRef.current = message.token;
          void loadDraft(message.token);
          break;
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [document, loadDraft]);

  const handleChangeBlock = useCallback(
    (blockId: string, block: EventPageBlock) => {
      if (!document) return;
      setDocument({
        ...document,
        blocks: document.blocks.map((b) => (b.id === blockId ? block : b)),
      });
      if (!suppressChangeRef.current) {
        sendMessage({ source: EDITOR_SOURCE, type: 'block-change', blockId, block });
      }
      suppressChangeRef.current = false;
    },
    [document, sendMessage],
  );

  const handleSelectBlock = useCallback(
    (blockId: string) => {
      setSelectedBlockId(blockId);
      sendMessage({ source: EDITOR_SOURCE, type: 'selection-change', blockId });
    },
    [sendMessage],
  );

  const handleReorderBlocks = useCallback(
    (blocks: EventPageBlock[]) => {
      if (!document) return;
      setDocument({ ...document, blocks });
      sendMessage({ source: EDITOR_SOURCE, type: 'blocks-reorder', blocks });
    },
    [document, sendMessage],
  );

  const handleDeleteBlock = useCallback(
    (blockId: string) => {
      if (!document) return;
      const blocks = document.blocks.filter((b) => b.id !== blockId);
      setDocument({ ...document, blocks });
      setSelectedBlockId(blocks[0]?.id);
      sendMessage({ source: EDITOR_SOURCE, type: 'block-delete', blockId });
    },
    [document, sendMessage],
  );

  const handleDuplicateBlock = useCallback(
    (blockId: string) => {
      if (!document) return;
      const index = document.blocks.findIndex((b) => b.id === blockId);
      if (index < 0) return;
      const original = document.blocks[index];
      const duplicate = {
        ...original,
        id: `${original.type}-${crypto.randomUUID()}`,
      } as EventPageBlock;
      const blocks = [
        ...document.blocks.slice(0, index + 1),
        duplicate,
        ...document.blocks.slice(index + 1),
      ];
      setDocument({ ...document, blocks });
      setSelectedBlockId(duplicate.id);
      sendMessage({ source: EDITOR_SOURCE, type: 'block-duplicate', blockId });
    },
    [document, sendMessage],
  );

  if (loading) {
    return (
      <SurfaceShell brand={brand}>
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-10 sm:px-6">
          <Skeleton className="h-12 w-full max-w-xl" />
          <Skeleton className="h-4 w-full max-w-md" />
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        </div>
      </SurfaceShell>
    );
  }

  if (error || !document || !context) {
    return (
      <SurfaceShell brand={brand}>
        <div className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
          <EmptyState
            icon={AlertCircleIcon}
            title="Unable to load draft preview"
            description={error ?? 'The draft could not be loaded.'}
            action={
              <Button variant="outline" onClick={() => void loadDraft(tokenRef.current)}>
                Try again
              </Button>
            }
          />
        </div>
      </SurfaceShell>
    );
  }

  return (
    <SurfaceShell brand={brand}>
      <div className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-6">
        <div className="tixkit-event-page" data-mode="edit" data-testid="edit-overlay-surface">
          <EventPageEditorSurface
            document={document}
            sampleContext={context}
            selectedBlockId={selectedBlockId}
            disabled={false}
            onSelectBlock={handleSelectBlock}
            onChangeBlock={handleChangeBlock}
            onReorderBlocks={handleReorderBlocks}
            onDeleteBlock={handleDeleteBlock}
            onDuplicateBlock={handleDuplicateBlock}
            renderRichTextBlock={({ block, disabled, onChange }) => (
              <EventPageRichTextEditor block={block} disabled={disabled} onChange={onChange} />
            )}
          />
        </div>
        {draft && !draft.validation.valid && (
          <div className="mt-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="font-semibold">Publish blockers</p>
            <ul className="mt-2 space-y-1">
              {draft.validation.issues.map((issue: unknown, index: number) => {
                const item = issue as { code?: string; message?: string };
                return (
                  <li key={`${item.code}-${index}`}>
                    {item.code}: {item.message}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </SurfaceShell>
  );
}

function SurfaceShell({ brand, children }: { brand: ResolvedBrand; children: React.ReactNode }) {
  return (
    <main className="min-h-svh bg-background text-foreground" style={brandThemeStyle(brand)}>
      {children}
    </main>
  );
}
