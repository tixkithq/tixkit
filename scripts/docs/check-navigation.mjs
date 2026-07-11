import { documentationNavigation } from '../../docs/navigation.ts';
import {
  assertNoErrors,
  loadPublicDocuments,
  rootFromMeta,
  validateNavigation,
} from './lib/content.mjs';

export function checkNavigation(root) {
  const { documents, errors } = loadPublicDocuments(root);
  return [...errors, ...validateNavigation(documents, documentationNavigation)];
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  assertNoErrors(checkNavigation(rootFromMeta(import.meta.url)), 'docs navigation');
