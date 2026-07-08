export type DocumentUndoEntry<TDocument> = {
  snapshot: TDocument;
  coalesceKey?: string;
  updatedAt: number;
};

export type DocumentUndoHistory<TDocument> = {
  past: DocumentUndoEntry<TDocument>[];
  present: TDocument;
  future: TDocument[];
};

export type DocumentUndoCommitOptions = {
  coalesceKey?: string;
  now?: number;
  coalesceWindowMs?: number;
};

export const DEFAULT_DOCUMENT_UNDO_COALESCE_WINDOW_MS = 1200;

export function createDocumentUndoHistory<TDocument>(
  document: TDocument,
): DocumentUndoHistory<TDocument> {
  return {
    past: [],
    present: document,
    future: [],
  };
}

export function commitDocumentUndoChange<TDocument>(
  history: DocumentUndoHistory<TDocument>,
  nextDocument: TDocument,
  options: DocumentUndoCommitOptions = {},
): DocumentUndoHistory<TDocument> {
  if (Object.is(history.present, nextDocument)) return history;

  const now = options.now ?? Date.now();
  const coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_DOCUMENT_UNDO_COALESCE_WINDOW_MS;
  const last = history.past.at(-1);
  const shouldCoalesce =
    Boolean(options.coalesceKey) &&
    last !== undefined &&
    last.coalesceKey === options.coalesceKey &&
    now - last.updatedAt <= coalesceWindowMs;

  if (shouldCoalesce && last) {
    return {
      past: [
        ...history.past.slice(0, -1),
        {
          ...last,
          updatedAt: now,
        },
      ],
      present: nextDocument,
      future: [],
    };
  }

  return {
    past: [
      ...history.past,
      {
        snapshot: history.present,
        coalesceKey: options.coalesceKey,
        updatedAt: now,
      },
    ],
    present: nextDocument,
    future: [],
  };
}

export function undoDocumentChange<TDocument>(
  history: DocumentUndoHistory<TDocument>,
): DocumentUndoHistory<TDocument> {
  const last = history.past.at(-1);
  if (!last) return history;
  return {
    past: history.past.slice(0, -1),
    present: last.snapshot,
    future: [history.present, ...history.future],
  };
}

export function redoDocumentChange<TDocument>(
  history: DocumentUndoHistory<TDocument>,
): DocumentUndoHistory<TDocument> {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [
      ...history.past,
      {
        snapshot: history.present,
        updatedAt: Date.now(),
      },
    ],
    present: next,
    future: history.future.slice(1),
  };
}

export function documentUndoAvailability<TDocument>(
  history: DocumentUndoHistory<TDocument> | undefined,
) {
  return {
    canUndo: Boolean(history?.past.length),
    canRedo: Boolean(history?.future.length),
  };
}
