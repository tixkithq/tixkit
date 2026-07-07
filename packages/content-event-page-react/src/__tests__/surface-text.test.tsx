import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import * as React from 'react';
import { SurfaceText, SurfaceEditingContext, type SurfaceEditing } from '../index.js';
import {
  createDefaultEventPageDocument,
} from '@tixkit/content-event-page';

function editingContext(overrides: Partial<SurfaceEditing> = {}): SurfaceEditing {
  const document = createDefaultEventPageDocument({
    eventId: 'evt',
    eventTitle: 'Title',
    eventDescription: 'Body',
    checkoutUrl: 'https://checkout.test/c',
  });
  return {
    document,
    disabled: false,
    onChangeBlock: vi.fn(),
    ...overrides,
  };
}

function renderEditable(props: React.ComponentProps<typeof SurfaceText>, ctx?: SurfaceEditing) {
  const context = ctx ?? editingContext();
  const onChange = props.onCommit ?? vi.fn();
  return render(
    <SurfaceEditingContext.Provider value={context}>
      <SurfaceText {...props} onCommit={onChange} />
    </SurfaceEditingContext.Provider>,
  );
}

describe('SurfaceText (public mode)', () => {
  it('renders a bare tag with no editing attributes when no editing context', () => {
    const { container } = render(
      <SurfaceText as="h1" blockId="hero" field="headline" value="Hello" onCommit={vi.fn()} />,
    );
    const h1 = container.querySelector('h1');
    expect(h1).not.toBeNull();
    expect(h1?.textContent).toBe('Hello');
    expect(h1?.getAttribute('contenteditable')).toBeNull();
    expect(h1?.getAttribute('data-editable-field')).toBeNull();
    expect(h1?.getAttribute('aria-label')).toBeNull();
  });

  it('renders display when provided in public mode', () => {
    const { container } = render(
      <SurfaceText as="h1" blockId="hero" field="headline" value="raw" display="resolved" onCommit={vi.fn()} />,
    );
    expect(container.querySelector('h1')?.textContent).toBe('resolved');
  });

  it('passes through anchor href and onClick in public mode', () => {
    const onClick = vi.fn((e: React.MouseEvent) => e.preventDefault());
    const { container } = render(
      <SurfaceText
        as="a"
        blockId="hero"
        field="ctaLabel"
        value="Get tickets"
        href="https://checkout.test/c"
        onClick={onClick}
        onCommit={vi.fn()}
      />,
    );
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://checkout.test/c');
    expect(anchor?.textContent).toBe('Get tickets');
    fireEvent.click(anchor!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('SurfaceText (edit mode)', () => {
  it('renders an editable tag with binding attributes', () => {
    const { container } = renderEditable({
      as: 'h1',
      blockId: 'hero',
      field: 'headline',
      value: 'Hello',
      placeholder: 'Page headline',
      ariaLabel: 'Page headline',
      onCommit: vi.fn(),
    });
    const h1 = container.querySelector('h1');
    expect(h1?.getAttribute('contenteditable')).toBe('true');
    expect(h1?.getAttribute('data-editable-field')).toBe('headline');
    expect(h1?.getAttribute('data-placeholder')).toBe('Page headline');
    expect(h1?.getAttribute('aria-label')).toBe('Page headline');
    expect(h1?.textContent).toBe('Hello');
  });

  it('fires onCommit with textContent on input', () => {
    const onCommit = vi.fn();
    const { container } = renderEditable({
      as: 'h1',
      blockId: 'hero',
      field: 'headline',
      value: 'Hello',
      onCommit,
    });
    const h1 = container.querySelector('h1')!;
    h1.textContent = 'Updated';
    fireEvent.input(h1);
    expect(onCommit).toHaveBeenCalledWith('Updated');
  });

  it('commits trimmed value on blur', () => {
    const onCommit = vi.fn();
    const { container } = renderEditable({
      as: 'h1',
      blockId: 'hero',
      field: 'headline',
      value: 'Hello',
      onCommit,
    });
    const h1 = container.querySelector('h1')!;
    h1.textContent = '  trimmed  ';
    fireEvent.blur(h1);
    expect(onCommit).toHaveBeenCalledWith('trimmed');
  });

  it('prevents Enter on single-line editables', () => {
    const onCommit = vi.fn();
    const { container } = renderEditable({
      as: 'h1',
      blockId: 'hero',
      field: 'headline',
      value: 'Hello',
      onCommit,
    });
    const h1 = container.querySelector('h1')!;
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { value: 'Enter' });
    h1.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('allows Enter on multiline editables', () => {
    const { container } = renderEditable({
      as: 'p',
      blockId: 'hero',
      field: 'body',
      value: 'Hello',
      multiline: true,
      onCommit: vi.fn(),
    });
    const p = container.querySelector('p')!;
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { value: 'Enter' });
    p.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('updates textContent when value changes while unfocused', () => {
    const ctxValue = editingContext();
    const { container, rerender } = render(
      <SurfaceEditingContext.Provider value={ctxValue}>
        <SurfaceText as="h1" blockId="hero" field="headline" value="Hello" onCommit={vi.fn()} />
      </SurfaceEditingContext.Provider>,
    );
    const h1 = container.querySelector('h1')!;
    expect(h1.textContent).toBe('Hello');
    rerender(
      <SurfaceEditingContext.Provider value={ctxValue}>
        <SurfaceText as="h1" blockId="hero" field="headline" value="Externally updated" onCommit={vi.fn()} />
      </SurfaceEditingContext.Provider>,
    );
    expect(container.querySelector('h1')!.textContent).toBe('Externally updated');
  });

  it('does not clobber textContent while focused', () => {
    const onCommit = vi.fn((v: string) => v);
    const ctxValue = editingContext();
    const { container, rerender } = render(
      <SurfaceEditingContext.Provider value={ctxValue}>
        <SurfaceText as="h1" blockId="hero" field="headline" value="Hello" onCommit={onCommit} />
      </SurfaceEditingContext.Provider>,
    );
    const h1 = container.querySelector('h1')!;
    act(() => {
      h1.focus();
      fireEvent.focus(h1);
    });
    h1.textContent = 'User typed';
    fireEvent.input(h1);
    expect(onCommit).toHaveBeenCalledWith('User typed');
    const committedValue = onCommit.mock.calls[0][0];
    rerender(
      <SurfaceEditingContext.Provider value={ctxValue}>
        <SurfaceText as="h1" blockId="hero" field="headline" value={committedValue} onCommit={onCommit} />
      </SurfaceEditingContext.Provider>,
    );
    // The effect must skip because the element is focused; textContent stays.
    expect(container.querySelector('h1')!.textContent).toBe('User typed');
  });

  it('renders disabled fields as non-contenteditable', () => {
    const ctx = editingContext({ disabled: true });
    const { container } = renderEditable(
      {
        as: 'h1',
        blockId: 'hero',
        field: 'headline',
        value: 'Locked',
        onCommit: vi.fn(),
      },
      ctx,
    );
    const h1 = container.querySelector('h1')!;
    expect(h1.getAttribute('contenteditable')).toBe('false');
    expect(h1.getAttribute('aria-disabled')).toBe('true');
  });
});
