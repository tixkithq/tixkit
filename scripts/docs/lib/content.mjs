import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  adoptionPaths,
  audiences,
  contentStatuses,
  contentTypes,
  docRoutes,
  productAreas,
} from '../../../packages/docs-core/dist/index.js';

const markdownExtensions = new Set(['.md', '.mdx']);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const headingPattern = /^(#{2,3})\s+(.+?)\s*#*$/gm;
const markdownLinkPattern = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
const htmlIdPattern = /\sid=["']([^"']+)["']/g;

export function walkFiles(root, directory, predicate = () => true) {
  const absoluteDirectory = resolve(root, directory);
  if (!existsSync(absoluteDirectory)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !['node_modules', 'dist', 'out'].includes(entry.name))
          visit(absolute);
      } else if (entry.isFile()) {
        const path = relative(root, absolute).split(sep).join('/');
        if (predicate(path)) files.push(path);
      }
    }
  };
  visit(absoluteDirectory);
  return files.sort();
}

export function slugifyHeading(value) {
  return value
    .toLowerCase()
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export function extractHeadings(body) {
  const counts = new Map();
  const headings = [];
  for (const match of body.matchAll(headingPattern)) {
    const text = match[2].trim();
    const base = slugifyHeading(text);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    headings.push({
      id: count === 0 ? base : `${base}-${count}`,
      text,
      level: match[1].length,
    });
  }
  for (const match of body.matchAll(htmlIdPattern)) {
    if (!headings.some((heading) => heading.id === match[1])) {
      headings.push({ id: match[1], text: match[1], level: 2 });
    }
  }
  return headings;
}

export function parseFrontmatter(source, path = '<source>') {
  const normalized = source.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n'))
    throw new Error(`${path}:1 missing opening frontmatter delimiter`);
  const end = normalized.indexOf('\n---\n', 4);
  if (end === -1) throw new Error(`${path}:1 missing closing frontmatter delimiter`);
  const yaml = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  let data;
  try {
    data = parseYaml(yaml);
  } catch (error) {
    throw new Error(
      `${path}: invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${path}: frontmatter must be a mapping`);
  }
  return { data, body };
}

function stringArray(value) {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '')
  );
}

export function validateFrontmatter(data, path) {
  const errors = [];
  for (const field of [
    'title',
    'description',
    'product_area',
    'content_type',
    'status',
    'owner',
    'last_verified',
  ]) {
    if (typeof data[field] !== 'string' || data[field].trim() === '')
      errors.push(`${path}: frontmatter.${field} must be a non-empty string`);
  }
  if (!stringArray(data.audience) || data.audience.length === 0)
    errors.push(`${path}: frontmatter.audience must be a non-empty string array`);
  else
    for (const value of data.audience)
      if (!audiences.includes(value)) errors.push(`${path}: invalid audience ${value}`);
  if (typeof data.product_area === 'string' && !productAreas.includes(data.product_area))
    errors.push(`${path}: invalid product_area ${data.product_area}`);
  if (typeof data.content_type === 'string' && !contentTypes.includes(data.content_type))
    errors.push(`${path}: invalid content_type ${data.content_type}`);
  if (
    typeof data.status === 'string' &&
    (!contentStatuses.includes(data.status) || data.status === 'internal')
  )
    errors.push(`${path}: public content cannot use status ${data.status}`);
  if (typeof data.last_verified === 'string' && !datePattern.test(data.last_verified))
    errors.push(`${path}: last_verified must use YYYY-MM-DD`);
  if (!stringArray(data.prerequisites))
    errors.push(`${path}: frontmatter.prerequisites must be a string array`);
  if (!stringArray(data.related))
    errors.push(`${path}: frontmatter.related must be a string array`);
  if (data.keywords !== undefined && !stringArray(data.keywords))
    errors.push(`${path}: frontmatter.keywords must be a string array when present`);
  if (data.adoption_paths !== undefined) {
    if (!stringArray(data.adoption_paths) || data.adoption_paths.length === 0)
      errors.push(
        `${path}: frontmatter.adoption_paths must be a non-empty string array when present`,
      );
    else {
      if (new Set(data.adoption_paths).size !== data.adoption_paths.length)
        errors.push(`${path}: frontmatter.adoption_paths must not contain duplicates`);
      for (const value of data.adoption_paths)
        if (!adoptionPaths.includes(value)) errors.push(`${path}: invalid adoption path ${value}`);
    }
  }
  if (data.hidden !== undefined && typeof data.hidden !== 'boolean')
    errors.push(`${path}: frontmatter.hidden must be boolean when present`);
  return errors;
}

export function routeFromPublicPath(path) {
  let route = path.replace(/^docs\/public\//, '').replace(/\.(?:md|mdx)$/, '');
  route = route.replace(/\/index$/, '');
  return route === 'index' || route === '' ? '/' : `/${route}`;
}

export function loadPublicDocuments(root) {
  const files = walkFiles(root, 'docs/public', (path) => markdownExtensions.has(extname(path)));
  const documents = [];
  const errors = [];
  for (const path of files) {
    const source = readFileSync(resolve(root, path), 'utf8');
    try {
      const { data, body } = parseFrontmatter(source, path);
      errors.push(...validateFrontmatter(data, path));
      documents.push({
        path,
        route: routeFromPublicPath(path),
        frontmatter: data,
        body,
        headings: extractHeadings(body),
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { documents, errors };
}

export function flattenNavigation(items, parent = '') {
  const entries = [];
  for (const item of items) {
    const location = parent ? `${parent} > ${item.label}` : item.label;
    if (item.routeId) entries.push({ label: item.label, routeId: item.routeId, location });
    if (item.children) entries.push(...flattenNavigation(item.children, location));
  }
  return entries;
}

export function extractMarkdownLinks(body) {
  return [...body.matchAll(markdownLinkPattern)].map((match) => ({
    label: match[1],
    target: match[2],
  }));
}

export function normalizeDocsTarget(sourceRoute, target) {
  const [rawPath, anchor] = target.split('#', 2);
  if (/^(?:https?:|mailto:|tel:)/.test(rawPath)) return { external: true, target };
  if (rawPath === '') return { external: false, route: sourceRoute, anchor };
  if (rawPath.startsWith('/'))
    return { external: false, route: rawPath.replace(/\/$/, '') || '/', anchor };
  const sourceSegments = sourceRoute.split('/').filter(Boolean);
  sourceSegments.pop();
  for (const segment of rawPath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') sourceSegments.pop();
    else sourceSegments.push(segment.replace(/\.(?:md|mdx)$/, ''));
  }
  return {
    external: false,
    route: `/${sourceSegments.join('/')}`.replace(/\/index$/, '') || '/',
    anchor,
  };
}

export function validateDocumentLinks(documents, extraRoutes = ['/']) {
  const errors = [];
  const byRoute = new Map(documents.map((document) => [document.route, document]));
  for (const route of extraRoutes) if (!byRoute.has(route)) byRoute.set(route, undefined);
  for (const document of documents) {
    for (const related of document.frontmatter.related ?? []) {
      const target = normalizeDocsTarget(document.route, related);
      if (target.external || !target.route || !byRoute.has(target.route)) {
        errors.push(`${document.path}: broken related page ${related}`);
      }
    }
    for (const link of extractMarkdownLinks(document.body)) {
      const target = normalizeDocsTarget(document.route, link.target);
      if (target.external) continue;
      if (!target.route || !byRoute.has(target.route)) {
        errors.push(`${document.path}: broken documentation link ${link.target}`);
        continue;
      }
      if (target.anchor) {
        const targetDocument = byRoute.get(target.route);
        if (
          !targetDocument ||
          !targetDocument.headings.some((heading) => heading.id === target.anchor)
        ) {
          errors.push(`${document.path}: broken documentation anchor ${link.target}`);
        }
      }
    }
  }
  return errors;
}

export function validateNavigation(documents, navigationItems) {
  const errors = [];
  const entries = flattenNavigation(navigationItems);
  const routeIds = new Set();
  const siblingLabels = new Map();
  for (const entry of entries) {
    if (!Object.hasOwn(docRoutes, entry.routeId))
      errors.push(`docs/navigation.ts: unknown DocRouteId ${entry.routeId}`);
    if (routeIds.has(entry.routeId))
      errors.push(`docs/navigation.ts: duplicate routeId ${entry.routeId}`);
    routeIds.add(entry.routeId);
    const parent = entry.location.slice(0, Math.max(0, entry.location.lastIndexOf(' > ')));
    const key = `${parent}\0${entry.label}`;
    if (siblingLabels.has(key))
      errors.push(`docs/navigation.ts: duplicate sibling label ${entry.label} under ${parent}`);
    siblingLabels.set(key, true);
  }
  const documentRoutes = new Set(documents.map((document) => document.route));
  for (const entry of entries) {
    const route = docRoutes[entry.routeId];
    if (route !== '/' && !documentRoutes.has(route))
      errors.push(`docs/navigation.ts: ${entry.routeId} targets missing page ${route}`);
  }
  for (const document of documents) {
    if (
      !document.frontmatter.hidden &&
      !entries.some((entry) => docRoutes[entry.routeId] === document.route)
    ) {
      errors.push(`${document.path}: public page is orphaned from navigation`);
    }
  }
  return errors;
}

export function validateRedirects(documents, redirects, options = {}) {
  const errors = [];
  const routes = new Map(documents.map((document) => [document.route, document]));
  const allowedDuplicateDestinations = new Set(options.allowedDuplicateDestinations ?? []);
  const destinations = new Map();

  for (const [source, destination] of Object.entries(redirects)) {
    if (!source.startsWith('/') || !destination.startsWith('/')) {
      errors.push(
        `docs/redirects.json: redirect must use absolute paths: ${source} -> ${destination}`,
      );
      continue;
    }
    if (source === destination) errors.push(`docs/redirects.json: self redirect ${source}`);
    if (Object.hasOwn(redirects, destination)) {
      errors.push(
        `docs/redirects.json: redirect chain ${source} -> ${destination} -> ${redirects[destination]}`,
      );
    }

    const destinationUrl = new URL(destination, 'https://docs.tixkit.test');
    const target = routes.get(destinationUrl.pathname);
    if (!target) {
      errors.push(`docs/redirects.json: ${source} targets missing page ${destination}`);
    } else if (
      destinationUrl.hash &&
      !target.headings.some((heading) => heading.id === destinationUrl.hash.slice(1))
    ) {
      errors.push(`docs/redirects.json: ${source} targets missing anchor ${destination}`);
    }

    const priorSource = destinations.get(destination);
    if (priorSource && !allowedDuplicateDestinations.has(destination)) {
      errors.push(
        `docs/redirects.json: duplicate destination ${destination} from ${priorSource} and ${source}`,
      );
    } else {
      destinations.set(destination, source);
    }
  }

  return errors;
}

export function packageDirectories(root) {
  const directory = resolve(root, 'packages');
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
    .filter((path) =>
      [
        'package.json',
        'Cargo.toml',
        'go.mod',
        'pubspec.yaml',
        'Package.swift',
        'build.gradle.kts',
      ].some((manifest) => existsSync(resolve(root, path, manifest))),
    )
    .sort();
}

export function packageName(root, directory) {
  const packageJson = resolve(root, directory, 'package.json');
  if (existsSync(packageJson)) return JSON.parse(readFileSync(packageJson, 'utf8')).name;
  const cargo = resolve(root, directory, 'Cargo.toml');
  if (existsSync(cargo)) return readFileSync(cargo, 'utf8').match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  const go = resolve(root, directory, 'go.mod');
  if (existsSync(go)) return readFileSync(go, 'utf8').match(/^module\s+(.+)$/m)?.[1];
  const pubspec = resolve(root, directory, 'pubspec.yaml');
  if (existsSync(pubspec)) return readFileSync(pubspec, 'utf8').match(/^name:\s*(.+)$/m)?.[1];
  return directory.split('/').at(-1);
}

export function validatePackageReadmes(root) {
  const errors = [];
  const requiredHeadings = [
    'Purpose',
    'Consumers',
    'Status',
    'Installation',
    'Example',
    'Public exports',
    'Runtime',
    'Configuration',
    'Security',
    'Validation',
    'Compatibility',
    'Related guides',
  ];
  for (const directory of packageDirectories(root)) {
    const path = `${directory}/README.md`;
    if (!existsSync(resolve(root, path))) {
      errors.push(`${path}: missing package README`);
      continue;
    }
    const content = readFileSync(resolve(root, path), 'utf8');
    const expectedName = packageName(root, directory);
    if (expectedName && !content.includes(expectedName))
      errors.push(`${path}: does not name package ${expectedName}`);
    for (const heading of requiredHeadings) {
      if (
        !new RegExp(
          `^#{2,3}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`,
          'im',
        ).test(content)
      ) {
        errors.push(`${path}: missing required heading ${heading}`);
      }
    }
    if (/\b(?:TODO|TBD|placeholder|coming soon)\b/i.test(content))
      errors.push(`${path}: contains a placeholder marker`);
  }
  return errors;
}

export function assertNoErrors(errors, label) {
  if (errors.length === 0) {
    console.log(`${label}: pass`);
    return;
  }
  for (const error of errors) console.error(error);
  throw new Error(`${label}: ${errors.length} error${errors.length === 1 ? '' : 's'}`);
}

export function rootFromMeta(metaUrl) {
  return resolve(new URL('../..', metaUrl).pathname);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function fileSize(path) {
  return statSync(path).size;
}
