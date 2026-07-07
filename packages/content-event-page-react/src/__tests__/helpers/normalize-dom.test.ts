import { describe, expect, it } from 'vitest';
import { normalizeSurfaceHtml, normalizeBlocksByHtml } from './normalize-dom.js';

function html(input: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = input.trim();
  return container.firstElementChild as HTMLElement;
}

describe('normalizeSurfaceHtml', () => {
  it('strips contenteditable and editable binding attributes', () => {
    const root = html(
      '<section class="tk-ep-hero" data-block-id="hero">' +
        '<h1 contenteditable="true" data-editable-field="headline" aria-label="Page headline" data-placeholder="Page headline" spellcheck="false" aria-multiline="false">Title</h1>' +
        '</section>',
    );
    expect(normalizeSurfaceHtml(root)).toBe(
      '<section class="tk-ep-hero" data-block-id="hero"><h1>Title</h1></section>',
    );
  });

  it('removes editor overlay chrome entirely', () => {
    const root = html(
      '<div class="tk-ep-canvas">' +
        '<section class="tk-ep-hero" data-block-id="hero"><h1>Title</h1></section>' +
        '<div data-editor-chrome="true"><button aria-label="Delete Hero">x</button></div>' +
        '</div>',
    );
    expect(normalizeSurfaceHtml(root)).toBe(
      '<div class="tk-ep-canvas"><section class="tk-ep-hero" data-block-id="hero"><h1>Title</h1></section></div>',
    );
  });

  it('strips ProseMirror editor classes, role, and data-pm attributes', () => {
    const root = html(
      '<section class="tk-ep-rich-text" data-block-id="rich-1">' +
        '<div class="ProseMirror tk-ep-rich-text__content" contenteditable="true" role="textbox" aria-multiline="true" spellcheck="false" data-pm-slice="0 0 []" data-placeholder="Add copy"><p>Hello</p></div>' +
        '</section>',
    );
    expect(normalizeSurfaceHtml(root)).toBe(
      '<section class="tk-ep-rich-text" data-block-id="rich-1">' +
        '<div class="tk-ep-rich-text__content"><p>Hello</p></div></section>',
    );
  });

  it('sorts attributes so insertion order does not affect comparison', () => {
    const a = html('<section data-block-id="hero" class="tk-ep-hero"><h1>Title</h1></section>');
    const b = html('<section class="tk-ep-hero" data-block-id="hero"><h1>Title</h1></section>');
    expect(normalizeSurfaceHtml(a)).toBe(normalizeSurfaceHtml(b));
  });

  it('collapses whitespace in text nodes', () => {
    const root = html(
      '<section class="tk-ep-hero" data-block-id="hero"><h1>  Hello   world  </h1></section>',
    );
    expect(normalizeSurfaceHtml(root)).toBe(
      '<section class="tk-ep-hero" data-block-id="hero"><h1> Hello world </h1></section>',
    );
  });

  it('serializes void elements without a closing tag', () => {
    const root = html('<hr class="tk-ep-divider" data-block-id="div-1">');
    expect(normalizeSurfaceHtml(root)).toBe('<hr class="tk-ep-divider" data-block-id="div-1">');
  });
});

describe('normalizeBlocksByHtml', () => {
  it('returns per-block normalized outerHTML keyed by data-block-id', () => {
    const root = html(
      '<div><section class="tk-ep-hero" data-block-id="hero">' +
        '<h1 contenteditable="true" data-editable-field="headline">Title</h1></section>' +
        '<section class="tk-ep-tickets" data-block-id="tickets"><h2>Tickets</h2></section></div>',
    );
    const blocks = normalizeBlocksByHtml(root);
    expect(blocks.get('hero')).toBe(
      '<section class="tk-ep-hero" data-block-id="hero"><h1>Title</h1></section>',
    );
    expect(blocks.get('tickets')).toBe(
      '<section class="tk-ep-tickets" data-block-id="tickets"><h2>Tickets</h2></section>',
    );
  });
});
