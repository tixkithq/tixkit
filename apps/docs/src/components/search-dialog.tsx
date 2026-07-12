'use client';

import type { AdoptionPath, Audience, DocsSearchRecord, ProductArea } from '@tixkit/docs-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { searchAdoptionPaths, searchAudiences, searchDocs, searchProductAreas } from '@/lib/search';

export function SearchDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [records, setRecords] = useState<readonly DocsSearchRecord[]>([]);
  const [query, setQuery] = useState('');
  const [audience, setAudience] = useState<Audience | undefined>();
  const [productArea, setProductArea] = useState<ProductArea | undefined>();
  const [adoptionPath, setAdoptionPath] = useState<AdoptionPath | undefined>();
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const results = searchDocs(records, query, { audience, productArea, adoptionPath });

  const openSearch = useCallback(async () => {
    dialogRef.current?.showModal();
    if (records.length > 0) {
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (loadState === 'loading') return;
    setLoadState('loading');
    try {
      const response = await fetch('/search-index.json');
      if (!response.ok) throw new Error('search index unavailable');
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) throw new TypeError('search index is not an array');
      setRecords(payload as DocsSearchRecord[]);
      setLoadState('ready');
      requestAnimationFrame(() => requestAnimationFrame(() => inputRef.current?.focus()));
    } catch {
      setLoadState('error');
      requestAnimationFrame(() =>
        dialogRef.current?.querySelector<HTMLButtonElement>('[data-search-retry]')?.focus(),
      );
    }
  }, [loadState, records.length]);

  function closeSearch() {
    dialogRef.current?.close();
    triggerRef.current?.focus();
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        void openSearch();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openSearch]);

  useEffect(() => {
    if (loadState === 'ready' && dialogRef.current?.open) inputRef.current?.focus();
  }, [loadState]);

  return (
    <>
      <button
        ref={triggerRef}
        className="search-trigger"
        type="button"
        onClick={() => void openSearch()}
      >
        Search documentation <kbd>⌘K</kbd>
      </button>
      <dialog
        ref={dialogRef}
        className="search-dialog"
        aria-labelledby="search-title"
        onCancel={closeSearch}
      >
        <div className="search-dialog__header">
          <h2 id="search-title">Search Tixkit documentation</h2>
          <button type="button" onClick={closeSearch} aria-label="Close search">
            Close
          </button>
        </div>
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search tasks, symptoms, APIs, and SDKs"
          aria-label="Documentation search query"
          disabled={loadState === 'loading' || loadState === 'error'}
        />
        <div className="search-filters" aria-label="Search filters">
          <select
            value={audience ?? ''}
            onChange={(event) =>
              setAudience((event.target.value || undefined) as Audience | undefined)
            }
            aria-label="Audience"
          >
            <option value="">All audiences</option>
            {searchAudiences.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            value={adoptionPath ?? ''}
            onChange={(event) =>
              setAdoptionPath((event.target.value || undefined) as AdoptionPath | undefined)
            }
            aria-label="Adoption path"
          >
            <option value="">All adoption paths</option>
            {searchAdoptionPaths.map((value) => (
              <option key={value} value={value}>
                {value === 'self-hosted' ? 'Run on my infrastructure' : value}
              </option>
            ))}
          </select>
          <select
            value={productArea ?? ''}
            onChange={(event) =>
              setProductArea((event.target.value || undefined) as ProductArea | undefined)
            }
            aria-label="Product area"
          >
            <option value="">All product areas</option>
            {searchProductAreas.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div className="search-results" aria-live="polite">
          {loadState === 'loading' ? <p>Loading the local documentation index…</p> : null}
          {loadState === 'error' ? (
            <div role="alert">
              <p>
                Search is temporarily unavailable. Browse the documentation navigation or retry.
              </p>
              <button data-search-retry type="button" onClick={() => void openSearch()}>
                Retry search
              </button>
            </div>
          ) : null}
          {query && results.length === 0 ? (
            <p>No matching documentation. Try a task or symptom.</p>
          ) : null}
          {results.map((result) => (
            <a key={result.url} href={result.url} onClick={closeSearch}>
              <strong>{result.title}</strong>
              {result.heading ? <span>In “{result.heading.text}”</span> : null}
              <small>{result.description}</small>
            </a>
          ))}
        </div>
      </dialog>
    </>
  );
}
