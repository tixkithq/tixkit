/**
 * Strips editing-only attributes and chrome so edit-mode DOM can be compared
 * to public-mode DOM structurally. Used by the edit/public parity test suite
 * to guarantee the single renderer produces identical content markup in both
 * modes (parity by construction).
 *
 * Removed entirely:
 *  - Editor overlay chrome ([data-editor-chrome]) - lives outside the page flow.
 *
 * Stripped from every element:
 *  - contenteditable (edit-only; public never emits it)
 *  - spellcheck (edit-only)
 *  - ProseMirror editor classes and data-pm-* attributes (TipTap edit surface)
 *  - aria-multiline / aria-disabled / role="textbox" (edit-only on editables)
 *
 * Stripped from editable text nodes ([data-editable-field]) and ProseMirror:
 *  - aria-label (public content carries no aria-labels)
 *  - data-placeholder (edit-only empty-state hint)
 *  - data-editable-field (edit-only binding marker)
 *
 * Whitespace in text nodes is collapsed so formatting differences do not cause
 * false negatives. Element attributes are serialized in sorted order so that
 * attribute insertion order (which differs between public and edit paths) does
 * not affect comparison.
 */

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const GLOBAL_STRIP_ATTRS = [
  'contenteditable',
  'spellcheck',
  'aria-multiline',
  'aria-disabled',
];

const EDITABLE_STRIP_ATTRS = [
  'aria-label',
  'data-placeholder',
  'data-editable-field',
];

const PROSEMIRROR_CLASSES = new Set([
  'ProseMirror',
  'ProseMirror-focused',
  'ProseMirror-noderangeselection',
  'ProseMirror-selectednode',
  'is-editor-empty',
  'is-empty',
  'ProseMirror-placeholder',
]);

function isEditableOrProseMirror(el: Element): boolean {
  return (
    el.hasAttribute('data-editable-field') ||
    el.classList.contains('ProseMirror') ||
    (el.closest('.ProseMirror') !== null)
  );
}

function stripEditAttributes(root: HTMLElement): void {
  root.querySelectorAll('[data-editor-chrome]').forEach((el) => el.remove());

  const all = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of all) {
    if (isEditableOrProseMirror(el)) {
      for (const attr of [...GLOBAL_STRIP_ATTRS, ...EDITABLE_STRIP_ATTRS]) {
        el.removeAttribute(attr);
      }
      if (el.getAttribute('role') === 'textbox') {
        el.removeAttribute('role');
      }
    } else {
      for (const attr of GLOBAL_STRIP_ATTRS) {
        el.removeAttribute(attr);
      }
    }

    for (const cls of PROSEMIRROR_CLASSES) {
      el.classList.remove(cls);
    }
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('data-pm-')) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').replace(/\s+/g, ' ');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const attrs = Array.from(el.attributes)
    .map((attr) => `${attr.name}="${attr.value}"`)
    .toSorted();
  const attrStr = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';

  if (VOID_ELEMENTS.has(tag)) {
    return `<${tag}${attrStr}>`;
  }
  const children = Array.from(el.childNodes).map(serializeNode).join('');
  return `<${tag}${attrStr}>${children}</${tag}>`;
}

export function normalizeSurfaceHtml(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  stripEditAttributes(clone);
  return serializeNode(clone).trim();
}

/**
 * Returns a map of block-id to normalized outerHTML for each [data-block-id]
 * descendant, so parity can be asserted per block type.
 */
export function normalizeBlocksByHtml(root: HTMLElement): Map<string, string> {
  const clone = root.cloneNode(true) as HTMLElement;
  stripEditAttributes(clone);
  const map = new Map<string, string>();
  clone.querySelectorAll('[data-block-id]').forEach((el) => {
    const id = el.getAttribute('data-block-id') ?? '';
    if (id) {
      map.set(id, serializeNode(el).trim());
    }
  });
  return map;
}
