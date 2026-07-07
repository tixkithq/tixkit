import { JSDOM } from 'jsdom';
import '@testing-library/jest-dom/vitest';

if (typeof window === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Node: dom.window.Node,
    File: dom.window.File,
    Blob: dom.window.Blob,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals)) {
    if (key in globalThis) continue;
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  // Node.js 22+ ships a read-only global navigator; only override when absent.
  if (!('navigator' in globalThis)) {
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      writable: true,
      configurable: true,
    });
  }
}

const elementPrototype = window.HTMLElement.prototype as HTMLElement & {
  attachEvent?: () => void;
  detachEvent?: () => void;
};

elementPrototype.attachEvent ??= () => {};
elementPrototype.detachEvent ??= () => {};
