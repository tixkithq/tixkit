import { describe, expect, it } from 'vitest';
import {
  commitDocumentUndoChange,
  createDocumentUndoHistory,
  redoDocumentChange,
  undoDocumentChange,
} from './document-undo-history';

describe('document undo history', () => {
  it('undoes and redoes committed document snapshots', () => {
    const initial = { title: 'One', body: 'Body' };
    const edited = { title: 'Two', body: 'Body' };
    const history = commitDocumentUndoChange(createDocumentUndoHistory(initial), edited);

    const undone = undoDocumentChange(history);
    expect(undone.present).toEqual(initial);
    expect(undone.future).toEqual([edited]);

    const redone = redoDocumentChange(undone);
    expect(redone.present).toEqual(edited);
    expect(redone.future).toEqual([]);
  });

  it('coalesces rapid commits with the same key into one undo entry', () => {
    const initial = { title: 'A', body: 'Body' };
    const first = { title: 'AB', body: 'Body' };
    const second = { title: 'ABC', body: 'Body' };
    const history = createDocumentUndoHistory(initial);
    const firstCommit = commitDocumentUndoChange(history, first, {
      coalesceKey: 'hero:headline',
      now: 100,
    });
    const secondCommit = commitDocumentUndoChange(firstCommit, second, {
      coalesceKey: 'hero:headline',
      now: 300,
    });

    expect(secondCommit.past).toHaveLength(1);
    expect(undoDocumentChange(secondCommit).present).toEqual(initial);
  });

  it('does not coalesce different fields or commits outside the coalesce window', () => {
    const initial = { title: 'A', body: 'Body' };
    const title = { title: 'B', body: 'Body' };
    const body = { title: 'B', body: 'Copy' };
    const delayedTitle = { title: 'C', body: 'Copy' };

    const titleCommit = commitDocumentUndoChange(createDocumentUndoHistory(initial), title, {
      coalesceKey: 'hero:headline',
      now: 100,
    });
    const bodyCommit = commitDocumentUndoChange(titleCommit, body, {
      coalesceKey: 'hero:body',
      now: 200,
    });
    const delayedCommit = commitDocumentUndoChange(bodyCommit, delayedTitle, {
      coalesceKey: 'hero:headline',
      now: 2_000,
    });

    expect(delayedCommit.past).toHaveLength(3);
  });
});
