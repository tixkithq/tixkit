import { JSDOM } from 'jsdom';
import '@testing-library/jest-dom/vitest';

if (typeof window === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, {
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
    navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  });
}

const elementPrototype = window.HTMLElement.prototype as HTMLElement & {
  attachEvent?: () => void;
  detachEvent?: () => void;
};

elementPrototype.attachEvent ??= () => {};
elementPrototype.detachEvent ??= () => {};
