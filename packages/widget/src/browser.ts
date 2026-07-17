// Lean browser/CDN entry. The package root retains the complete runtime export
// surface; direct script consumers only need registration and widget classes.
export {
  issueWidgetRuntimeUrl,
  TIXKIT_WIDGET_VERSION,
  TixkitButton,
  TixkitWidget,
} from './index.js';
export type * from '@tixkit/embed-core';
