/**
 * List of available font names. Used by the appearance settings to generate
 * dynamic font classes (e.g. `font-inter`, `font-manrope`).
 *
 * Tailwind v4: add a matching `--font-<name>` variable in `src/app/globals.css`
 * under `@theme inline` when introducing a new font.
 */
export const fonts = ['inter', 'manrope', 'system'] as const;
