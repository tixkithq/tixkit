import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { StyleInspector } from './style-inspector';

vi.mock('@react-email/editor/ui', () => ({
  Inspector: {
    Root: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement('div', props, children),
    Breadcrumb: () => React.createElement('span', null, 'Body'),
    Document: () => React.createElement('section', null, 'Document styles'),
    Node: ({
      children,
    }: {
      children?: (context: {
        nodeType: string;
        getAttr: () => undefined;
        setAttr: () => undefined;
        getStyle: () => undefined;
        setStyle: () => undefined;
        batchSetStyle: () => undefined;
      }) => React.ReactNode;
    }) =>
      React.createElement(
        'section',
        null,
        children?.({
          nodeType: 'image',
          getAttr: () => undefined,
          setAttr: () => undefined,
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
    render(<StyleInspector />);

    expect(screen.getByText('Page style')).toBeInTheDocument();
    expect(screen.getByText('Document styles')).toBeInTheDocument();
    expect(screen.getByText('Attributes')).toBeInTheDocument();
    expect(screen.getByText('Size')).toBeInTheDocument();
    expect(screen.getByText('Background')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit theme/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Global CSS')).not.toBeInTheDocument();
  });
});
