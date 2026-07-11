import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';
import { CodeBlock } from './components/code-block';
import { SdkGuide } from './components/sdk-guide';
import { FrameworkTabs } from './components/framework-tabs';
import { OpenApiReference, OpenApiSchemaReference } from './components/openapi-reference';
import { WebhookReference } from './components/webhook-reference';

function headingId(children: ComponentProps<'h2'>['children']): string | undefined {
  if (typeof children !== 'string') return undefined;
  return children
    .toLowerCase()
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function H2(props: ComponentProps<'h2'>) {
  const id = props.id ?? headingId(props.children);
  return (
    <h2 {...props} id={id}>
      {props.children}
      {id ? (
        <a
          className="heading-anchor"
          href={`#${id}`}
          aria-label={`Link to ${String(props.children)}`}
        >
          #
        </a>
      ) : null}
    </h2>
  );
}

function H3(props: ComponentProps<'h3'>) {
  const id = props.id ?? headingId(props.children);
  return (
    <h3 {...props} id={id}>
      {props.children}
      {id ? (
        <a
          className="heading-anchor"
          href={`#${id}`}
          aria-label={`Link to ${String(props.children)}`}
        >
          #
        </a>
      ) : null}
    </h3>
  );
}

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h2: H2,
    h3: H3,
    pre: CodeBlock,
    FrameworkTabs,
    OpenApiReference,
    OpenApiSchemaReference,
    WebhookReference,
    SdkGuide,
    ...components,
  };
}
