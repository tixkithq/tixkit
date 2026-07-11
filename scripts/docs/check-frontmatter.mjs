import { assertNoErrors, loadPublicDocuments, rootFromMeta } from './lib/content.mjs';

export function checkFrontmatter(root) {
  const { documents, errors } = loadPublicDocuments(root);
  if (documents.length === 0) errors.push('docs/public: no public documentation pages found');
  const routes = new Set();
  for (const document of documents) {
    if (routes.has(document.route))
      errors.push(`${document.path}: duplicate public route ${document.route}`);
    routes.add(document.route);
  }
  return errors;
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  assertNoErrors(checkFrontmatter(rootFromMeta(import.meta.url)), 'docs frontmatter');
