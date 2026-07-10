import type * as React from 'react';

export const STUDIO_COLORS = {
  bg: '#DCE1E4',
  bg2: '#FFFFFF',
  bg3: '#F6F6F6',
  bg4: '#F0F0F0',
  fg: '#332C2C',
  fg2: '#726A6A',
  fg3: '#A2A9AA',
  stroke: '#F0F0F0',
  buttonBorder: '#E8E9E9',
  tipBadge: '#5B6E7A',
} as const;

export const STUDIO_FONT_FAMILIES = {
  heading: 'Geist, Inter, Arial, sans-serif',
  body: 'Inter, Arial, sans-serif',
} as const;

export const STUDIO_TYPE = {
  headline: {
    fontFamily: STUDIO_FONT_FAMILIES.heading,
    fontSize: '40px',
    fontWeight: 700,
    letterSpacing: '-0.8px',
    lineHeight: 1.2,
  },
  sectionTitle: {
    fontFamily: STUDIO_FONT_FAMILIES.heading,
    fontSize: '24px',
    fontWeight: 600,
    letterSpacing: '-0.12px',
    lineHeight: 1.4,
  },
  quote: {
    fontFamily: STUDIO_FONT_FAMILIES.heading,
    fontSize: '22px',
    fontWeight: 500,
    letterSpacing: '-0.176px',
    lineHeight: 1.4,
  },
  emphasis: {
    fontSize: '15px',
    fontWeight: 500,
    letterSpacing: '-0.042px',
    lineHeight: 1.6,
  },
  body: {
    fontSize: '14px',
    fontWeight: 400,
    letterSpacing: '-0.042px',
    lineHeight: 1.6,
  },
  meta: {
    fontSize: '13px',
    letterSpacing: '-0.13px',
    lineHeight: 1.5,
  },
  legal: {
    fontSize: '11px',
    letterSpacing: '-0.11px',
    lineHeight: 1.5,
  },
} as const satisfies Record<string, React.CSSProperties>;

export const STUDIO_BUTTON_STYLE = {
  ...STUDIO_TYPE.emphasis,
  backgroundColor: STUDIO_COLORS.bg2,
  border: `1px solid ${STUDIO_COLORS.buttonBorder}`,
  borderRadius: '8px',
  boxShadow:
    '0px 3px 2px 0px rgba(22,29,29,0.05), 0px 1px 1px 0px rgba(22,29,29,0.09), 0px 0px 1px 0px rgba(22,29,29,0.1)',
  color: '#1F2222',
  display: 'inline-block',
  padding: '12px 20px',
  textDecoration: 'none',
} satisfies React.CSSProperties;

export function styleAttr(style: React.CSSProperties): string {
  return Object.entries(style)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([property, value]) => {
      const cssValue = String(value).replaceAll('"', "'");
      return `${property.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}: ${cssValue}`;
    })
    .join('; ');
}
