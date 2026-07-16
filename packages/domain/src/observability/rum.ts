export const RUM_SCHEMA_VERSION = 'tixkit-rum-v1' as const;
export const RUM_SURFACES = ['checkout', 'event-page'] as const;
export const RUM_WEB_VITALS = ['LCP', 'INP', 'CLS'] as const;

export type RumSurface = (typeof RUM_SURFACES)[number];
export type RumWebVital = (typeof RUM_WEB_VITALS)[number];

export const RUM_MAXIMUM_VALUES: Readonly<Record<RumWebVital, number>> = Object.freeze({
  LCP: 60,
  INP: 10,
  CLS: 10,
});
