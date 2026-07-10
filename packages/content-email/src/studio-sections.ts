import type * as React from 'react';
import type { StudioAction, StudioFact, StudioTemplateDefinition } from './studio-templates.js';
import {
  STUDIO_BUTTON_STYLE,
  STUDIO_COLORS,
  STUDIO_FONT_FAMILIES,
  STUDIO_TYPE,
  styleAttr,
} from './theme.js';

const outerStyle = {
  backgroundColor: STUDIO_COLORS.bg2,
  color: STUDIO_COLORS.fg,
  fontFamily: STUDIO_FONT_FAMILIES.body,
  margin: '0',
  padding: '0',
} satisfies React.CSSProperties;

const containerStyle = {
  margin: '0 auto',
  maxWidth: '640px',
  padding: '24px',
  width: '100%',
} satisfies React.CSSProperties;

const canvasStyle = {
  backgroundColor: STUDIO_COLORS.bg3,
  borderRadius: '20px',
  overflow: 'hidden',
  padding: '56px 32px 32px',
} satisfies React.CSSProperties;

const contentStyle = {
  margin: '0 auto',
  maxWidth: '480px',
} satisfies React.CSSProperties;

const bodyStyle = {
  ...STUDIO_TYPE.body,
  color: STUDIO_COLORS.fg2,
  margin: '0 0 12px',
} satisfies React.CSSProperties;

const sectionStyle = {
  margin: '0 0 28px',
} satisfies React.CSSProperties;

function optionalAttribute(optionalTag: string | undefined): string {
  return optionalTag ? ` data-studio-optional-value="{{${optionalTag}}}"` : '';
}

export function brandHeader(): string {
  return [
    `<div data-studio-section="brand-header" style="${styleAttr({ margin: '0 0 44px', textAlign: 'center' })}">`,
    `<div data-studio-optional-value="{{brand.logoUrl}}" style="${styleAttr({ margin: '0 0 14px', textAlign: 'center' })}">`,
    `<img src="{{brand.logoUrl}}" alt="{{brand.name}} logo" width="160" style="display: inline-block; height: auto;" />`,
    '</div>',
    `<p style="${styleAttr({ ...STUDIO_TYPE.emphasis, color: STUDIO_COLORS.fg, margin: '0' })}">{{brand.name}}</p>`,
    '</div>',
  ].join('');
}

export function hero(definition: StudioTemplateDefinition): string {
  const compact = definition.archetype === 'ops';
  return [
    `<div style="${styleAttr({ ...sectionStyle, textAlign: compact ? 'left' : 'center' })}">`,
    `<h1 style="${styleAttr({
      ...(compact ? STUDIO_TYPE.sectionTitle : STUDIO_TYPE.headline),
      color: STUDIO_COLORS.fg,
      margin: '0 0 18px',
    })}">${definition.headline}</h1>`,
    ...definition.intro.map((paragraph) => `<p style="${styleAttr(bodyStyle)}">${paragraph}</p>`),
    definition.primaryAction ? actionButton(definition.primaryAction, '22px 0 0') : '',
    '</div>',
  ].join('');
}

export function itemRow(item: NonNullable<StudioTemplateDefinition['item']>): string {
  return [
    `<div data-studio-section="item-row"${optionalAttribute(item.optionalTag)} style="${styleAttr({
      ...sectionStyle,
      backgroundColor: STUDIO_COLORS.bg4,
      borderRadius: '16px',
      padding: '20px',
    })}">`,
    `<p style="${styleAttr({ ...STUDIO_TYPE.emphasis, color: STUDIO_COLORS.fg, margin: '0 0 6px' })}">${item.title}</p>`,
    ...item.meta.map(
      (line) =>
        `<p style="${styleAttr({ ...STUDIO_TYPE.meta, color: STUDIO_COLORS.fg3, margin: '2px 0 0' })}">${line}</p>`,
    ),
    '</div>',
  ].join('');
}

function rows(title: string, entries: readonly StudioFact[], finalDivider: boolean): string {
  return [
    `<div data-studio-section="${title.toLowerCase()}" style="${styleAttr(sectionStyle)}">`,
    `<p style="${styleAttr({ ...STUDIO_TYPE.meta, color: STUDIO_COLORS.fg3, margin: '0 0 10px' })}">${title}</p>`,
    `<div style="${styleAttr({ backgroundColor: STUDIO_COLORS.bg4, borderRadius: '16px', padding: '8px 18px' })}">`,
    ...entries.map((entry, index) => {
      const isFinal = finalDivider && index === entries.length - 1;
      return [
        `<div data-studio-row="true"${optionalAttribute(entry.optionalTag)} style="${styleAttr({
          borderTop: index > 0 || isFinal ? `1px solid ${STUDIO_COLORS.stroke}` : undefined,
          padding: '11px 0',
        })}">`,
        `<p style="${styleAttr({ ...STUDIO_TYPE.body, color: STUDIO_COLORS.fg2, display: 'inline-block', margin: '0', width: '42%' })}">${entry.label}</p>`,
        `<p style="${styleAttr({ ...STUDIO_TYPE.emphasis, color: STUDIO_COLORS.fg, display: 'inline-block', margin: '0', textAlign: 'right', width: '58%' })}">${entry.value}</p>`,
        '</div>',
      ].join('');
    }),
    '</div>',
    '</div>',
  ].join('');
}

export function factList(entries: readonly StudioFact[]): string {
  return rows('Details', entries, false);
}

export function totals(entries: readonly StudioFact[]): string {
  return rows('Summary', entries, true);
}

export function qrPanel(qr: NonNullable<StudioTemplateDefinition['qr']>): string {
  return [
    `<div data-studio-section="qr-panel"${optionalAttribute(qr.optionalTag)} style="${styleAttr({
      ...sectionStyle,
      backgroundColor: STUDIO_COLORS.bg2,
      borderRadius: '16px',
      padding: '28px',
      textAlign: 'center',
    })}">`,
    `<img src="${qr.imageUrl}" alt="Ticket QR code" style="${styleAttr({ display: 'block', height: '180px', margin: '0 auto', maxWidth: '100%', width: '180px' })}" />`,
    qr.code
      ? `<p style="${styleAttr({ ...STUDIO_TYPE.meta, color: STUDIO_COLORS.fg3, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: '0.08em', margin: '14px 0 0' })}">${qr.code}</p>`
      : '',
    '</div>',
  ].join('');
}

function actionButton(action: StudioAction, margin: string): string {
  return [
    `<p data-studio-action="true"${optionalAttribute(action.optionalTag)} style="${styleAttr({ margin, textAlign: 'inherit' })}">`,
    `<a href="${action.url}" style="${styleAttr(STUDIO_BUTTON_STYLE)}">${action.label}</a>`,
    '</p>',
  ].join('');
}

export function walletRow(actions: readonly StudioAction[]): string {
  return [
    `<div data-studio-section="wallet-row" style="${styleAttr({ ...sectionStyle, textAlign: 'center' })}">`,
    ...actions.map((entry) => actionButton(entry, '0 6px 10px')),
    '</div>',
  ].join('');
}

export function benefits(lines: readonly string[]): string {
  return [
    `<div data-studio-section="benefits" style="${styleAttr({ ...sectionStyle, borderTop: `1px solid ${STUDIO_COLORS.stroke}`, paddingTop: '22px' })}">`,
    ...lines.map((line) => `<p style="${styleAttr(bodyStyle)}">✓ ${line}</p>`),
    '</div>',
  ].join('');
}

export function quote(value: string): string {
  return [
    `<div data-studio-section="quote" style="${styleAttr({ ...sectionStyle, backgroundColor: STUDIO_COLORS.bg4, borderRadius: '10px', padding: '28px', textAlign: 'center' })}">`,
    `<p style="${styleAttr({ ...STUDIO_TYPE.meta, color: STUDIO_COLORS.fg3, margin: '0 0 10px' })}">★★★★★</p>`,
    `<p style="${styleAttr({ ...STUDIO_TYPE.quote, color: STUDIO_COLORS.fg, margin: '0' })}">“${value}”</p>`,
    '</div>',
  ].join('');
}

export function statTiles(entries: readonly StudioFact[]): string {
  return [
    `<div data-studio-section="stat-tiles" style="${styleAttr(sectionStyle)}">`,
    ...entries.map((entry) =>
      [
        `<div data-studio-stat="true"${optionalAttribute(entry.optionalTag)} style="${styleAttr({ backgroundColor: STUDIO_COLORS.bg4, borderRadius: '16px', display: 'inline-block', margin: '0 2% 10px 0', padding: '18px', verticalAlign: 'top', width: '31%' })}">`,
        `<p style="${styleAttr({ ...STUDIO_TYPE.sectionTitle, color: STUDIO_COLORS.fg, margin: '0 0 4px' })}">${entry.value}</p>`,
        `<p style="${styleAttr({ ...STUDIO_TYPE.meta, color: STUDIO_COLORS.fg3, margin: '0' })}">${entry.label}</p>`,
        '</div>',
      ].join(''),
    ),
    '</div>',
  ].join('');
}

export function footer(complianceNote?: string): string {
  return [
    `<div style="${styleAttr({ borderTop: `1px solid ${STUDIO_COLORS.stroke}`, paddingTop: '22px' })}">`,
    `<p style="${styleAttr({ ...STUDIO_TYPE.meta, color: STUDIO_COLORS.fg2, margin: '0 0 8px' })}">Need help? Visit <a href="{{brand.supportUrl}}" style="color: ${STUDIO_COLORS.fg}">{{brand.name}} support</a>.</p>`,
    complianceNote
      ? `<p style="${styleAttr({ ...STUDIO_TYPE.legal, color: STUDIO_COLORS.fg3, margin: '0' })}">${complianceNote}</p>`
      : `<p style="${styleAttr({ ...STUDIO_TYPE.legal, color: STUDIO_COLORS.fg3, margin: '0' })}">Sent by {{brand.name}}.</p>`,
    '</div>',
  ].join('');
}

export function composeStudioTemplate(
  definition: StudioTemplateDefinition,
  options: { complianceNote?: string } = {},
): string {
  return [
    `<div data-studio-email="true" data-studio-archetype="${definition.archetype}" style="${styleAttr(outerStyle)}">`,
    `<div data-type="container" style="${styleAttr(containerStyle)}">`,
    `<div style="${styleAttr(canvasStyle)}">`,
    `<div style="${styleAttr(contentStyle)}">`,
    brandHeader(),
    hero(definition),
    definition.item ? itemRow(definition.item) : '',
    definition.qr ? qrPanel(definition.qr) : '',
    definition.facts?.length ? factList(definition.facts) : '',
    definition.stats?.length ? statTiles(definition.stats) : '',
    definition.totals?.length ? totals(definition.totals) : '',
    definition.wallets?.length ? walletRow(definition.wallets) : '',
    definition.benefits?.length ? benefits(definition.benefits) : '',
    definition.quote ? quote(definition.quote) : '',
    definition.body
      ? `<div data-studio-section="body" style="${styleAttr(sectionStyle)}"><p style="${styleAttr(bodyStyle)}">${definition.body}</p></div>`
      : '',
    definition.secondaryActions?.length ? walletRow(definition.secondaryActions) : '',
    footer(options.complianceNote),
    '</div>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}
