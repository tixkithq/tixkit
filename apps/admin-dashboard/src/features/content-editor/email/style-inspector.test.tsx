import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { StyleInspector } from './style-inspector';

const inspectorState = vi.hoisted(() => ({
  nodeType: 'image',
  style: '',
  setAttr: vi.fn(),
}));

vi.mock('@react-email/editor/ui', () => ({
  Inspector: {
    Root: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement('div', props, children),
    Breadcrumb: () => React.createElement('span', null, 'Body'),
    Document: () =>
      React.createElement(
        'section',
        { 'data-re-inspector-section': '' },
        React.createElement(
          'div',
          { 'data-re-inspector-section-header': '' },
          React.createElement('span', { 'data-re-inspector-text': '' }, 'Background'),
        ),
        React.createElement(
          'div',
          { 'data-re-inspector-prop-row': '' },
          React.createElement('label', { 'data-re-inspector-label': '' }, 'Color'),
          React.createElement('input', {
            'data-re-inspector-color-trigger': '',
            type: 'color',
          }),
          React.createElement('input', {
            'data-re-inspector-color-hex': '',
            type: 'text',
          }),
        ),
        React.createElement(
          'div',
          { 'data-re-inspector-prop-row': '' },
          React.createElement('label', { 'data-re-inspector-label': '' }, 'Padding'),
          React.createElement('input', {
            'data-re-inspector-input': '',
            type: 'text',
          }),
        ),
        'Document styles',
      ),
    Node: ({
      children,
    }: {
      children?: (context: {
        nodeType: string;
        getAttr: (name: string) => unknown;
        setAttr: (name: string, value: unknown) => void;
        getStyle: () => undefined;
        setStyle: () => undefined;
        batchSetStyle: () => undefined;
      }) => React.ReactNode;
    }) =>
      React.createElement(
        'section',
        null,
        children?.({
          nodeType: inspectorState.nodeType,
          getAttr: (name: string) => (name === 'style' ? inspectorState.style : undefined),
          setAttr: inspectorState.setAttr,
          getStyle: () => undefined,
          setStyle: () => undefined,
          batchSetStyle: () => undefined,
        }) ?? 'Node styles',
      ),
    Attributes: () => React.createElement('div', null, 'Attributes'),
    Size: () => React.createElement('div', null, 'Size'),
    Padding: () => React.createElement('div', null, 'Padding'),
    ColumnSpacing: () => React.createElement('div', null, 'Column spacing'),
    Background: () => React.createElement('div', null, 'Background'),
    Border: () => React.createElement('div', null, 'Border'),
  },
}));

describe('StyleInspector', () => {
  it('renders document and node style sections', () => {
    const { container } = render(<StyleInspector />);

    expect(screen.getByText('Page style')).toBeInTheDocument();
    expect(container.querySelector('.tixkit-email-native-inspector')).toBeInTheDocument();
    expect(screen.getByText('Document styles')).toBeInTheDocument();
    expect(screen.getByText('Attributes')).toBeInTheDocument();
    expect(screen.getByText('Size')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Image alignment' })).toBeInTheDocument();
    expect(screen.getAllByText('Background')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Edit theme/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Global CSS')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Background Color picker')).toBeInTheDocument();
    expect(screen.getByLabelText('Background Color hex value')).toBeInTheDocument();
    expect(screen.getByLabelText('Background Padding value')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Right' }));
    expect(inspectorState.setAttr).toHaveBeenCalledWith('alignment', 'right');
  });

  it('uploads a hero background and applies email-safe image styles', async () => {
    inspectorState.nodeType = 'section';
    inspectorState.style = 'background-color: #06233f; min-height: 320px';
    inspectorState.setAttr.mockClear();
    const onUploadImage = vi.fn().mockResolvedValue({
      url: 'https://assets.example.test/hero.jpg',
    });
    const { container } = render(<StyleInspector onUploadImage={onUploadImage} />);

    const fileInput = container.querySelector('input[type="file"]');
    expect(screen.getByText('Hero background')).toBeInTheDocument();
    fireEvent.change(fileInput!, {
      target: { files: [new File(['hero'], 'hero.jpg', { type: 'image/jpeg' })] },
    });

    await waitFor(() => expect(onUploadImage).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(inspectorState.setAttr).toHaveBeenCalledWith(
        'style',
        expect.stringContaining('url("https://assets.example.test/hero.jpg")'),
      ),
    );
    expect(inspectorState.setAttr).toHaveBeenCalledWith(
      'style',
      expect.stringContaining('background-size: cover'),
    );
  });
});
