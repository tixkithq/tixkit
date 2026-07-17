import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { parseSync } from 'oxc-parser';
import {
  registryAllowsDynamicNetworkTarget,
  loadProviderIntegrationRegistry,
  pathMatchesPolicy,
  registryHostPolicies,
  registryImportPolicies,
  registryNetworkTargetAuthorities,
  registryNonNetworkReceiverTypes,
  registryNonProviderHostPolicies,
  registryTransportExecutorPolicies,
  registryTransportExecutors,
  sourceSha256,
} from './provider-integration-registry.mjs';

const sourceExtension = /\.(?:astro|cjs|cts|js|jsx|mjs|mts|svelte|ts|tsx|vue)$/u;
const componentSourceExtension = /\.(?:astro|svelte|vue)$/u;
const ignoredSegment =
  /(?:^|\/)(?:\.astro|\.dart_tool|\.expo|\.next|\.nuxt|\.output|\.svelte-kit|\.turbo|__tests__|build|coverage|dist|fixtures|generated|node_modules|out|test-results)(?:\/|$)/u;
const testFile = /(?:^|\/)[^/]+\.(?:integration\.)?(?:spec|test)\.[^.]+$/u;
const networkMethodNames = new Set([
  '$fetch',
  'delete',
  'fetch',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'request',
  'sendBeacon',
]);

function normalizedModulePath(path) {
  return normalize(path)
    .replaceAll('\\', '/')
    .replace(/\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u, '')
    .replace(/\/index$/u, '');
}

function exactSourcePath(path) {
  return normalize(path).replaceAll('\\', '/');
}

function workspaceImportIdentity(path, source, imported, availableWorkspaceModulePaths) {
  if (!source.startsWith('.')) return;
  const base = exactSourcePath(join(dirname(path), source));
  const extensions = ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'];
  const candidates = new Set();
  const addIfPresent = (candidate) => {
    if (availableWorkspaceModulePaths.has(candidate)) candidates.add(candidate);
  };
  addIfPresent(base);
  const extension = extensions.find((candidate) => base.endsWith(candidate));
  if (extension) {
    const stem = base.slice(0, -extension.length);
    for (const candidateExtension of extensions) addIfPresent(`${stem}${candidateExtension}`);
  } else {
    for (const candidateExtension of extensions) {
      addIfPresent(`${base}${candidateExtension}`);
      addIfPresent(`${base}/index${candidateExtension}`);
    }
  }
  if (candidates.size !== 1) return;
  return {
    type: 'workspace-export',
    path: [...candidates][0],
    export: imported,
  };
}

function issuerIdentityMatches(issuer, identity) {
  if (!issuer || !identity || issuer.type !== identity.type || issuer.export !== identity.export) {
    return false;
  }
  if (issuer.type === 'package-export') return issuer.package === identity.package;
  return exactSourcePath(issuer.path) === exactSourcePath(identity.path);
}

function authorityForIdentity(authorities, identity) {
  const authority = [...authorities.values()].find(({ issuer }) =>
    issuerIdentityMatches(issuer, identity),
  );
  if (
    authority?.issuer.type === 'workspace-export' &&
    !authorities.trustedWorkspaceIssuerIdentities?.has(symbolIdentityKey(identity))
  ) {
    return;
  }
  return authority;
}

function symbolIdentityKey(identity) {
  if (!identity) return;
  return identity.type === 'package-export'
    ? `package:${identity.package}#${identity.export}`
    : `workspace:${exactSourcePath(identity.path)}#${identity.export}`;
}

function exportedCollectionFactoryIdentityKeys(path, source) {
  const parsed = parseSync(path, source, { preserveParens: true });
  if (parsed.errors.length > 0) return [];
  const keys = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'FunctionDeclaration' &&
      node.declaration.id?.name &&
      node.declaration.returnType &&
      [
        'Headers',
        'Map',
        'ReadonlyMap',
        'ReadonlySet',
        'Set',
        'URLSearchParams',
        'WeakMap',
        'WeakSet',
      ].some((name) => syntaxContainsIdentifier(node.declaration.returnType, name)) &&
      syntaxContainsBuiltinCollectionConstruction(node.declaration.body)
    ) {
      keys.push(
        symbolIdentityKey({
          type: 'workspace-export',
          path,
          export: node.declaration.id.name,
        }),
      );
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent' || key === 'scope') continue;
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) visit(child);
    }
  };
  visit(parsed.program);
  return keys;
}

function bindingValues(bindings, reference) {
  if (reference?.type === 'Identifier' && typeof bindings.resolve === 'function') {
    return bindings.resolve(reference);
  }
  const name = typeof reference === 'string' ? reference : reference?.name;
  return name ? (bindings.get(name) ?? []) : [];
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      [
        '.astro',
        '.dart_tool',
        '.expo',
        '.next',
        '.nuxt',
        '.output',
        '.svelte-kit',
        '.turbo',
        '__tests__',
        'build',
        'coverage',
        'dist',
        'fixtures',
        'generated',
        'node_modules',
        'out',
        'test-results',
      ].includes(entry.name)
    ) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function normalizedRelative(root, path) {
  return relative(root, path).replaceAll('\\', '/');
}

function isRuntimeSource(path) {
  return (
    sourceExtension.test(path) &&
    !/\.d\.(?:cts|mts|ts)$/u.test(path) &&
    !ignoredSegment.test(path) &&
    !testFile.test(path)
  );
}

function expressionBeforeBinding(source, prefix, separators) {
  if (!source.startsWith(prefix)) return;
  const value = source.slice(prefix.length);
  const positions = [];
  for (const separator of separators) {
    for (
      let position = value.indexOf(separator);
      position >= 0;
      position = value.indexOf(separator, position + 1)
    ) {
      positions.push(position);
    }
  }
  positions.sort((left, right) => right - left);
  for (const position of positions) {
    const expression = value.slice(0, position).trim();
    if (parseSync('component-binding.tsx', `void (${expression});`).errors.length === 0) {
      return expression;
    }
  }
}

function componentExpressionSource(expression) {
  const trimmed = expression.trim();
  const awaitBinding = expressionBeforeBinding(trimmed, '#await ', [' catch ', ' then ']);
  if (awaitBinding) return `void (${awaitBinding});`;
  const snippet = /^#snippet\s+([A-Za-z_$][\w$]*\s*\([\s\S]*\))$/u.exec(trimmed);
  if (snippet) return `function ${snippet[1]} {}`;
  const directSpecial =
    /^(?:#(?:await|if|key)|@(?:attach|debug|html|render)|:else\s+if)\s+([\s\S]+)$/u.exec(trimmed);
  if (directSpecial) return `void (${directSpecial[1]});`;
  const each = expressionBeforeBinding(trimmed, '#each ', [' as ']);
  if (each) return `void (${each});`;
  const declaration = /^@const\s+([\s\S]+)$/u.exec(trimmed);
  if (declaration) return `function __tixkitComponentDeclaration() { const ${declaration[1]}; }`;
  return `void (${trimmed});`;
}

function parserBoundBraceExpressions(source) {
  const expressions = [];
  for (let open = source.indexOf('{'); open >= 0; open = source.indexOf('{', open + 1)) {
    for (
      let close = source.indexOf('}', open + 1);
      close >= 0;
      close = source.indexOf('}', close + 1)
    ) {
      const expression = source.slice(open + 1, close).trim();
      const normalizedSource = componentExpressionSource(expression);
      const parsed = parseSync('component-expression.tsx', normalizedSource);
      if (parsed.errors.length === 0) {
        expressions.push(normalizedSource);
        break;
      }
    }
  }
  return [...new Set(expressions)];
}

function componentHandlerExpressions(markup) {
  const expressions = [];
  const handler =
    /(?:^|\s)(?:on[a-z][\w:.-]*|v-[\w-]+(?::(?:\[[^\]]+\]|[\w-]+))?(?:\.[\w-]+)*|[@:#](?:\[[^\]]+\]|[\w:-]+)(?:\.[\w-]+)*)\s*=/giu;
  for (const match of markup.matchAll(handler)) {
    let cursor = (match.index ?? 0) + match[0].length;
    const delimiter = markup[cursor];
    if (delimiter === '"' || delimiter === "'") {
      cursor += 1;
      const end = markup.indexOf(delimiter, cursor);
      if (end >= 0) expressions.push(markup.slice(cursor, end).trim());
      continue;
    }
    if (delimiter === '{') {
      const [expression] = parserBoundBraceExpressions(markup.slice(cursor));
      if (expression !== undefined) expressions.push(expression);
      continue;
    }
    let end = cursor;
    while (end < markup.length && !/[\s>]/u.test(markup[end])) end += 1;
    expressions.push(markup.slice(cursor, end).trim());
  }
  return expressions;
}

function executableComponentSources(path, source) {
  if (!componentSourceExtension.test(path)) return [{ path, source }];

  const sources = [];
  if (path.endsWith('.astro')) {
    const frontmatter = /^(?:\uFEFF)?\s*---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/u.exec(source);
    if (frontmatter) sources.push({ path: `${path}.frontmatter.ts`, source: frontmatter[1] });
  }

  const scriptBlock = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu;
  let match;
  let index = 0;
  while ((match = scriptBlock.exec(source)) !== null) {
    const attributes = match[1];
    const type = /\btype\s*=\s*["']([^"']+)["']/iu.exec(attributes)?.[1]?.toLowerCase();
    if (
      type &&
      ![
        'application/ecmascript',
        'application/javascript',
        'module',
        'text/ecmascript',
        'text/javascript',
      ].includes(type)
    ) {
      continue;
    }
    const language = /\blang\s*=\s*["']([^"']+)["']/iu.exec(attributes)?.[1]?.toLowerCase();
    if (language && !['js', 'jsx', 'ts', 'tsx'].includes(language)) continue;
    index += 1;
    sources.push({
      path: `${path}.script-${index}.${language ?? 'js'}`,
      source: match[2],
    });
  }

  let markup = source.replace(scriptBlock, '');
  if (path.endsWith('.astro')) {
    markup = markup.replace(/^(?:\uFEFF)?\s*---\s*\r?\n[\s\S]*?\r?\n---(?:\s*\r?\n|$)/u, '');
  }

  for (const expression of componentHandlerExpressions(markup)) {
    index += 1;
    sources.push({
      path: `${path}.handler-${index}.ts`,
      source: `function __tixkitComponentHandler() { ${expression} }`,
    });
  }

  for (const expression of parserBoundBraceExpressions(markup)) {
    index += 1;
    sources.push({
      path: `${path}.expression-${index}.tsx`,
      source: expression,
    });
  }
  return sources;
}

function staticStrings(node, bindings, seen = new Set()) {
  if (!node) return [];
  if (node.type === 'Literal' && typeof node.value === 'string') return [node.value];
  if (node.type === 'StringLiteral') return [node.value];
  if (node.type === 'TemplateElement') return [node.value?.cooked ?? node.value?.raw ?? ''];
  if (node.type === 'SequenceExpression') {
    return staticStrings(node.expressions.at(-1), bindings, seen);
  }
  if (
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TypeCastExpression'
  ) {
    return staticStrings(node.expression, bindings, seen);
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticStrings(node.left, bindings, seen);
    const right = staticStrings(node.right, bindings, seen);
    return left
      .flatMap((leftValue) => right.map((rightValue) => leftValue + rightValue))
      .slice(0, 64);
  }
  if (node.type === 'TemplateLiteral') {
    let values = [node.quasis[0]?.value?.cooked ?? node.quasis[0]?.value?.raw ?? ''];
    for (let index = 0; index < node.expressions.length; index += 1) {
      const expressions = staticStrings(node.expressions[index], bindings, seen);
      if (expressions.length === 0) return [];
      const quasi = node.quasis[index + 1];
      const suffix = quasi?.value?.cooked ?? quasi?.value?.raw ?? '';
      values = values
        .flatMap((value) => expressions.map((expression) => value + expression + suffix))
        .slice(0, 64);
    }
    return values;
  }
  if (node.type === 'Identifier') {
    if (seen.has(node.name)) return [];
    const initializers = bindingValues(bindings, node);
    const nextSeen = new Set([...seen, node.name]);
    return [
      ...new Set(
        initializers
          .slice(0, 64)
          .flatMap((initializer) => staticStrings(initializer, bindings, nextSeen)),
      ),
    ].slice(0, 64);
  }
  if (
    node.type === 'NewExpression' &&
    node.callee?.type === 'Identifier' &&
    (node.callee.name === 'URL' || node.callee.name === 'Request')
  ) {
    const targets = staticStrings(node.arguments?.[0], bindings, seen);
    if (node.callee.name !== 'URL' || node.arguments?.[1] === undefined) return targets;
    const bases = staticStrings(node.arguments[1], bindings, seen);
    if (targets.length === 0 || bases.length === 0) return [];
    return targets.flatMap((target) =>
      bases.flatMap((base) => {
        try {
          return [new URL(target, base).toString()];
        } catch {
          return [];
        }
      }),
    );
  }
  if (
    node.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'String'
  ) {
    return staticStrings(node.arguments?.[0], bindings, seen);
  }
  if (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    ((!node.callee.computed && node.callee.property?.name === 'join') ||
      (node.callee.computed &&
        staticStrings(node.callee.property, bindings, seen).includes('join'))) &&
    node.callee.object
  ) {
    const separatorValues =
      node.arguments.length === 0 ? [','] : staticStrings(node.arguments[0], bindings, seen);
    if (separatorValues.length === 0) return [];
    const arrays = staticBoundNodes(node.callee.object, bindings, seen).filter(
      (candidate) => candidate.type === 'ArrayExpression',
    );
    const joined = [];
    for (const array of arrays) {
      const elementValues = array.elements.map((element) => staticStrings(element, bindings, seen));
      if (elementValues.some((values) => values.length === 0)) continue;
      let combinations = [[]];
      for (const values of elementValues) {
        combinations = combinations
          .flatMap((combination) => values.map((value) => [...combination, value]))
          .slice(0, 64);
      }
      joined.push(
        ...combinations.flatMap((combination) =>
          separatorValues.map((separator) => combination.join(separator)),
        ),
      );
    }
    return joined.slice(0, 64);
  }
  if (
    node.type === 'MemberExpression' &&
    ((!node.computed && node.property?.name === 'href') ||
      (node.computed && staticStrings(node.property, bindings, seen).includes('href')))
  ) {
    return staticStrings(node.object, bindings, seen);
  }
  return [];
}

function staticBoundNodes(node, bindings, seen = new Set()) {
  if (!node) return [];
  if (
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TypeCastExpression'
  ) {
    return staticBoundNodes(node.expression, bindings, seen);
  }
  if (node.type === 'SequenceExpression') {
    return staticBoundNodes(node.expressions.at(-1), bindings, seen);
  }
  if (node.type !== 'Identifier') return [node];
  if (seen.has(node.name)) return [];
  const nextSeen = new Set([...seen, node.name]);
  return bindingValues(bindings, node).flatMap((initializer) =>
    staticBoundNodes(initializer, bindings, nextSeen),
  );
}

function staticNetworkArgumentStrings(node, bindings) {
  const direct = staticStrings(node, bindings);
  if (direct.length > 0) return direct;
  return staticBoundNodes(node, bindings).flatMap((candidate) => {
    if (candidate.type !== 'ObjectExpression') return [];
    return candidate.properties.flatMap((property) => {
      if (property.type !== 'Property') return [];
      const keys = property.computed
        ? staticStrings(property.key, bindings)
        : [property.key?.name ?? property.key?.value].filter(Boolean);
      if (!keys.some((key) => ['endpoint', 'href', 'uri', 'url'].includes(key))) return [];
      return staticStrings(property.value, bindings);
    });
  });
}

function calleeNames(expression, bindings, seen = new Set()) {
  if (!expression) return [];
  if (expression.type === 'Identifier') {
    if (seen.has(expression.name)) return [expression.name];
    const nextSeen = new Set([...seen, expression.name]);
    return [
      expression.name,
      ...bindingValues(bindings, expression).flatMap((value) =>
        calleeNames(value, bindings, nextSeen),
      ),
    ];
  }
  if (expression.type === 'MemberExpression') {
    return expression.computed
      ? staticStrings(expression.property, bindings)
      : [expression.property?.name].filter(Boolean);
  }
  if (expression.type === 'SequenceExpression') {
    return calleeNames(expression.expressions.at(-1), bindings, seen);
  }
  return [];
}

function memberPropertyNames(expression, bindings) {
  if (expression?.type !== 'MemberExpression') return [];
  return expression.computed
    ? staticStrings(expression.property, bindings)
    : [expression.property?.name].filter(Boolean);
}

function isNetworkCallable(expression, bindings, seen = new Set()) {
  if (!expression || seen.has(expression)) return false;
  const nextSeen = new Set(seen).add(expression);
  if (expression.type === 'SequenceExpression') {
    return isNetworkCallable(expression.expressions.at(-1), bindings, nextSeen);
  }
  if (expression.type === 'Identifier') {
    const initializers = [...new Set(bindingValues(bindings, expression))];
    if (initializers.length > 0) {
      return initializers.some((initializer) => isNetworkCallable(initializer, bindings, nextSeen));
    }
    return networkMethodNames.has(expression.name);
  }
  if (
    expression.type === 'ParenthesizedExpression' ||
    expression.type === 'TSAsExpression' ||
    expression.type === 'TSSatisfiesExpression' ||
    expression.type === 'TSNonNullExpression' ||
    expression.type === 'TypeCastExpression'
  ) {
    return isNetworkCallable(expression.expression, bindings, nextSeen);
  }
  if (
    expression.type === 'ArrowFunctionExpression' ||
    expression.type === 'FunctionExpression' ||
    expression.type === 'FunctionDeclaration'
  ) {
    return containsDirectNetworkInvocation(expression.body, bindings, nextSeen);
  }
  if (
    expression.type === 'CallExpression' &&
    expression.callee?.type === 'MemberExpression' &&
    memberPropertyNames(expression.callee, bindings).includes('bind')
  ) {
    return isNetworkCallable(expression.callee.object, bindings, nextSeen);
  }
  if (expression.type !== 'MemberExpression') return false;
  const propertyNames = memberPropertyNames(expression, bindings);
  if (
    propertyNames.some((name) => name === 'apply' || name === 'call' || name === 'bind') &&
    isNetworkCallable(expression.object, bindings, nextSeen)
  ) {
    return true;
  }
  if (propertyNames.some((name) => ['fetch', 'request', 'sendBeacon'].includes(name))) return true;
  if (propertyNames.some((name) => ['delete', 'patch', 'post', 'put'].includes(name))) {
    return true;
  }
  if (
    propertyNames.includes('get') &&
    staticBoundNodes(expression.object, bindings).some(
      (candidate) => candidate.type === 'Identifier' && candidate.name === '__tixkitHttpNamespace',
    )
  ) {
    return true;
  }
  for (const object of staticBoundNodes(expression.object, bindings)) {
    if (object.type !== 'ObjectExpression') continue;
    for (const property of object.properties) {
      if (property.type !== 'Property') continue;
      const keys = property.computed
        ? staticStrings(property.key, bindings)
        : [property.key?.name ?? property.key?.value].filter(Boolean);
      if (
        keys.some((key) => propertyNames.includes(key)) &&
        isNetworkCallable(property.value, bindings, nextSeen)
      ) {
        return true;
      }
    }
  }
  return false;
}

function containsNetworkCallableValue(node, bindings, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return false;
  seen.add(node);
  if (node.type === 'Identifier') {
    const initializers = [...new Set(bindingValues(bindings, node))];
    if (initializers.length > 0) {
      return initializers.some((initializer) =>
        containsNetworkCallableValue(initializer, bindings, seen),
      );
    }
    return node.name === 'fetch';
  }
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    return false;
  }
  if (node.type === 'MemberExpression') {
    const propertyNames = memberPropertyNames(node, bindings);
    if (propertyNames.some((name) => ['fetch', 'sendBeacon'].includes(name))) {
      return true;
    }
    for (const object of staticBoundNodes(node.object, bindings)) {
      if (object.type !== 'ObjectExpression') continue;
      for (const property of object.properties ?? []) {
        if (property.type !== 'Property') continue;
        const keys = property.computed
          ? staticStrings(property.key, bindings)
          : [property.key?.name ?? property.key?.value].filter(Boolean);
        if (
          keys.some((key) => propertyNames.includes(key)) &&
          containsNetworkCallableValue(property.value, bindings, seen)
        ) {
          return true;
        }
      }
    }
    return false;
  }
  if (isNetworkCallable(node, bindings)) return true;
  if (
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TypeCastExpression'
  ) {
    return containsNetworkCallableValue(node.expression, bindings, seen);
  }
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
    const alternatives =
      node.type === 'ConditionalExpression'
        ? [node.consequent, node.alternate]
        : [node.left, node.right];
    return alternatives.some((candidate) =>
      containsNetworkCallableValue(candidate, bindings, seen),
    );
  }
  if (node.type === 'SequenceExpression') {
    return containsNetworkCallableValue(node.expressions.at(-1), bindings, seen);
  }
  if (node.type === 'ArrayExpression') {
    return (node.elements ?? []).some((element) =>
      containsNetworkCallableValue(element, bindings, seen),
    );
  }
  if (node.type === 'ObjectExpression') {
    return (node.properties ?? []).some((property) =>
      property.type === 'Property'
        ? containsNetworkCallableValue(property.value, bindings, seen)
        : property.type === 'SpreadElement'
          ? containsNetworkCallableValue(property.argument, bindings, seen)
          : false,
    );
  }
  return false;
}

function containsDirectNetworkInvocation(node, bindings, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return false;
  seen.add(node);
  if (node.type === 'CallExpression') {
    const callee = node.callee;
    if (
      (callee?.type === 'Identifier' && networkMethodNames.has(callee.name)) ||
      (callee?.type === 'MemberExpression' &&
        memberPropertyNames(callee, bindings).some((name) =>
          ['fetch', 'request'].includes(name),
        )) ||
      isFetchCallable(callee, bindings)
    ) {
      return true;
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'scope') continue;
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (
        child !== node &&
        child?.type !== 'FunctionDeclaration' &&
        child?.type !== 'FunctionExpression' &&
        child?.type !== 'ArrowFunctionExpression' &&
        containsDirectNetworkInvocation(child, bindings, seen)
      ) {
        return true;
      }
    }
  }
  return false;
}

function containsNetworkInvocation(node, bindings, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return false;
  const nextSeen = new Set(seen).add(node);
  if (node.type === 'CallExpression' && isNetworkCallable(node.callee, bindings, nextSeen)) {
    return true;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'scope') continue;
    if (Array.isArray(value)) {
      if (value.some((entry) => containsNetworkInvocation(entry, bindings, nextSeen))) return true;
    } else if (containsNetworkInvocation(value, bindings, nextSeen)) {
      return true;
    }
  }
  return false;
}

function isFetchCallable(expression, bindings, seen = new Set()) {
  if (!expression || seen.has(expression)) return false;
  const nextSeen = new Set(seen).add(expression);
  if (expression.type === 'SequenceExpression') {
    return isFetchCallable(expression.expressions.at(-1), bindings, nextSeen);
  }
  if (expression.type === 'Identifier') {
    if (expression.name === 'fetch') return true;
    const initializers = [...new Set(bindingValues(bindings, expression))];
    if (initializers.length === 0) return false;
    return initializers.every((initializer) => isFetchCallable(initializer, bindings, nextSeen));
  }
  if (
    expression.type === 'ParenthesizedExpression' ||
    expression.type === 'TSAsExpression' ||
    expression.type === 'TSSatisfiesExpression' ||
    expression.type === 'TSNonNullExpression' ||
    expression.type === 'TypeCastExpression'
  ) {
    return isFetchCallable(expression.expression, bindings, nextSeen);
  }
  if (
    expression.type === 'ArrowFunctionExpression' ||
    expression.type === 'FunctionExpression' ||
    expression.type === 'FunctionDeclaration'
  ) {
    return containsFetchInvocation(expression.body, bindings, nextSeen);
  }
  if (expression.type !== 'MemberExpression') return false;
  const propertyNames = memberPropertyNames(expression, bindings);
  if (
    propertyNames.some((name) => name === 'apply' || name === 'call' || name === 'bind') &&
    isFetchCallable(expression.object, bindings, nextSeen)
  ) {
    return true;
  }
  if (propertyNames.includes('fetch')) return true;
  for (const object of staticBoundNodes(expression.object, bindings)) {
    if (object.type !== 'ObjectExpression') continue;
    for (const property of object.properties) {
      if (property.type !== 'Property') continue;
      const keys = property.computed
        ? staticStrings(property.key, bindings)
        : [property.key?.name ?? property.key?.value].filter(Boolean);
      if (
        keys.some((key) => propertyNames.includes(key)) &&
        isFetchCallable(property.value, bindings, nextSeen)
      ) {
        return true;
      }
    }
  }
  return false;
}

function containsFetchInvocation(node, bindings, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return false;
  const nextSeen = new Set(seen).add(node);
  if (node.type === 'CallExpression' && isFetchCallable(node.callee, bindings, nextSeen)) {
    return true;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'scope') continue;
    if (Array.isArray(value)) {
      if (value.some((entry) => containsFetchInvocation(entry, bindings, nextSeen))) return true;
    } else if (containsFetchInvocation(value, bindings, nextSeen)) {
      return true;
    }
  }
  return false;
}

function containsRuntimeConfiguredTarget(
  node,
  bindings,
  seenNodes = new Set(),
  seenNames = new Set(),
) {
  if (!node || typeof node !== 'object' || seenNodes.has(node)) return false;
  const nextNodes = new Set(seenNodes).add(node);
  if (node.type === 'Identifier') {
    if (seenNames.has(node.name)) return false;
    const nextNames = new Set(seenNames).add(node.name);
    return bindingValues(bindings, node).some((initializer) =>
      containsRuntimeConfiguredTarget(initializer, bindings, nextNodes, nextNames),
    );
  }
  if (
    node.type === 'NewExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'URL'
  ) {
    if (staticStrings(node, bindings).some((value) => providerHosts(value).length > 0))
      return false;
    return true;
  }
  if (node.type === 'MemberExpression') {
    const propertyNames = memberPropertyNames(node, bindings);
    const object = node.object;
    if (
      propertyNames.includes('env') &&
      ((object?.type === 'Identifier' && object.name === 'process') ||
        object?.type === 'MetaProperty')
    ) {
      return true;
    }
    if (
      object?.type === 'MemberExpression' &&
      memberPropertyNames(object, bindings).includes('env') &&
      ((object.object?.type === 'Identifier' && object.object.name === 'process') ||
        object.object?.type === 'MetaProperty')
    ) {
      return true;
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'scope') continue;
    if (Array.isArray(value)) {
      if (
        value.some((entry) =>
          containsRuntimeConfiguredTarget(entry, bindings, nextNodes, seenNames),
        )
      )
        return true;
    } else if (containsRuntimeConfiguredTarget(value, bindings, nextNodes, seenNames)) {
      return true;
    }
  }
  return false;
}

function runtimeEnvironmentVariables(
  node,
  bindings,
  variables = new Set(),
  seenNodes = new Set(),
  seenNames = new Set(),
) {
  if (!node || typeof node !== 'object' || seenNodes.has(node)) return variables;
  seenNodes.add(node);
  if (node.type === 'Identifier') {
    if (seenNames.has(node.name)) return variables;
    seenNames.add(node.name);
    for (const initializer of bindingValues(bindings, node)) {
      runtimeEnvironmentVariables(initializer, bindings, variables, seenNodes, seenNames);
    }
    return variables;
  }
  if (node.type === 'MemberExpression') {
    const object = node.object;
    if (
      object?.type === 'MemberExpression' &&
      memberPropertyNames(object, bindings).includes('env') &&
      ((object.object?.type === 'Identifier' && object.object.name === 'process') ||
        object.object?.type === 'MetaProperty')
    ) {
      for (const name of memberPropertyNames(node, bindings)) variables.add(name);
      if (node.computed && memberPropertyNames(node, bindings).length === 0) variables.add('*');
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'scope') continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        runtimeEnvironmentVariables(entry, bindings, variables, seenNodes, seenNames);
      }
    } else {
      runtimeEnvironmentVariables(value, bindings, variables, seenNodes, seenNames);
    }
  }
  return variables;
}

function configuredNetworkTargetKind(node, bindings, seenNodes = new Set(), seenNames = new Set()) {
  void node;
  void bindings;
  void seenNodes;
  void seenNames;
  return undefined;
}

function networkTargetSources(
  node,
  bindings,
  sources = new Set(),
  seenNodes = new Set(),
  seenNames = new Set(),
) {
  if (!node || typeof node !== 'object' || seenNodes.has(node)) return sources;
  seenNodes.add(node);
  if (node.type === 'Identifier') {
    sources.add(node.name);
    if (seenNames.has(node.name)) return sources;
    seenNames.add(node.name);
    for (const initializer of bindingValues(bindings, node)) {
      networkTargetSources(initializer, bindings, sources, seenNodes, seenNames);
    }
    return sources;
  }
  if (node.type === 'PrivateIdentifier') {
    sources.add(`#${node.name}`);
    return sources;
  }
  if (node.type === 'MemberExpression') {
    for (const name of memberPropertyNames(node, bindings)) sources.add(name);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'scope') continue;
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      networkTargetSources(child, bindings, sources, seenNodes, seenNames);
    }
  }
  return sources;
}

function isSyntacticallyRelativeTarget(node, bindings, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return false;
  const nextSeen = new Set(seen).add(node);
  if (node.type === 'Identifier') {
    const initializers = bindingValues(bindings, node);
    return (
      initializers.length > 0 &&
      initializers.every((initializer) =>
        isSyntacticallyRelativeTarget(initializer, bindings, nextSeen),
      )
    );
  }
  if (node.type === 'SequenceExpression') {
    return isSyntacticallyRelativeTarget(node.expressions.at(-1), bindings, nextSeen);
  }
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
    const alternatives =
      node.type === 'ConditionalExpression'
        ? [node.consequent, node.alternate]
        : [node.left, node.right];
    return alternatives.every((alternative) =>
      isSyntacticallyRelativeTarget(alternative, bindings, nextSeen),
    );
  }
  if (
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TypeCastExpression'
  ) {
    return isSyntacticallyRelativeTarget(node.expression, bindings, nextSeen);
  }
  const beginsRelative = (value) =>
    typeof value === 'string' &&
    (value.startsWith('/') ||
      value.startsWith('./') ||
      value.startsWith('../') ||
      value.startsWith('?') ||
      value.startsWith('#'));
  if (node.type === 'Literal' || node.type === 'StringLiteral') return beginsRelative(node.value);
  if (node.type === 'TemplateLiteral') {
    const prefix = node.quasis[0]?.value?.cooked ?? node.quasis[0]?.value?.raw;
    return (
      beginsRelative(prefix) ||
      (prefix === '' &&
        node.expressions.length > 0 &&
        isSyntacticallyRelativeTarget(node.expressions[0], bindings, nextSeen))
    );
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return isSyntacticallyRelativeTarget(node.left, bindings, nextSeen);
  }
  return false;
}

function isDynamicLoaderCallable(expression, bindings, loaders, seen = new Set()) {
  if (!expression || seen.has(expression)) return false;
  const nextSeen = new Set(seen).add(expression);
  if (expression.type === 'Identifier') {
    if (loaders.has(expression.name)) return true;
    return bindingValues(bindings, expression).some((initializer) =>
      isDynamicLoaderCallable(initializer, bindings, loaders, nextSeen),
    );
  }
  if (expression.type === 'SequenceExpression') {
    return isDynamicLoaderCallable(expression.expressions.at(-1), bindings, loaders, nextSeen);
  }
  if (
    expression.type === 'ParenthesizedExpression' ||
    expression.type === 'TSAsExpression' ||
    expression.type === 'TSSatisfiesExpression' ||
    expression.type === 'TSNonNullExpression' ||
    expression.type === 'TypeCastExpression'
  ) {
    return isDynamicLoaderCallable(expression.expression, bindings, loaders, nextSeen);
  }
  if (
    expression.type === 'CallExpression' &&
    expression.callee?.type === 'MemberExpression' &&
    memberPropertyNames(expression.callee, bindings).some((name) =>
      ['bind', 'call', 'apply'].includes(name),
    )
  ) {
    return isDynamicLoaderCallable(expression.callee.object, bindings, loaders, nextSeen);
  }
  if (expression.type !== 'MemberExpression') return false;
  const names = memberPropertyNames(expression, bindings);
  if (names.some((name) => loaders.has(name))) return true;
  if (
    names.some((name) => name === 'apply' || name === 'bind' || name === 'call') &&
    isDynamicLoaderCallable(expression.object, bindings, loaders, nextSeen)
  ) {
    return true;
  }
  for (const object of staticBoundNodes(expression.object, bindings)) {
    if (object.type !== 'ObjectExpression') continue;
    for (const property of object.properties ?? []) {
      if (property.type !== 'Property') continue;
      const keys = property.computed
        ? staticStrings(property.key, bindings)
        : [property.key?.name ?? property.key?.value].filter(Boolean);
      if (
        keys.some((key) => names.includes(key)) &&
        isDynamicLoaderCallable(property.value, bindings, loaders, nextSeen)
      ) {
        return true;
      }
    }
  }
  return false;
}

function transportExecutorNames(
  expression,
  bindings,
  policies,
  names = new Set(),
  seen = new Set(),
) {
  if (!expression || typeof expression !== 'object' || seen.has(expression)) return names;
  const nextSeen = new Set(seen).add(expression);
  if (expression.type === 'Identifier') {
    if (policies.has(expression.name)) names.add(expression.name);
    for (const initializer of bindingValues(bindings, expression)) {
      transportExecutorNames(initializer, bindings, policies, names, nextSeen);
    }
    return names;
  }
  if (expression.type === 'SequenceExpression') {
    return transportExecutorNames(
      expression.expressions.at(-1),
      bindings,
      policies,
      names,
      nextSeen,
    );
  }
  if (expression.type === 'MemberExpression') {
    const properties = memberPropertyNames(expression, bindings);
    for (const property of properties) if (policies.has(property)) names.add(property);
    if (properties.some((property) => ['apply', 'bind', 'call'].includes(property))) {
      transportExecutorNames(expression.object, bindings, policies, names, nextSeen);
    }
    for (const object of staticBoundNodes(expression.object, bindings)) {
      if (object.type === 'ArrayExpression') {
        const indices =
          expression.property?.type === 'Literal' && Number.isSafeInteger(expression.property.value)
            ? [expression.property.value]
            : staticStrings(expression.property, bindings);
        for (const index of indices) {
          const element = object.elements?.[Number(index)];
          transportExecutorNames(element, bindings, policies, names, nextSeen);
        }
      }
      if (object.type === 'ObjectExpression') {
        for (const property of object.properties ?? []) {
          if (property.type !== 'Property') continue;
          const keys = property.computed
            ? staticStrings(property.key, bindings)
            : [property.key?.name ?? property.key?.value].filter(Boolean);
          if (keys.some((key) => properties.includes(key))) {
            transportExecutorNames(property.value, bindings, policies, names, nextSeen);
          }
        }
      }
    }
  }
  return names;
}

function targetAlternatives(node) {
  if (!node) return [];
  if (node.type === 'ConditionalExpression') {
    return [...targetAlternatives(node.consequent), ...targetAlternatives(node.alternate)];
  }
  if (node.type === 'LogicalExpression') {
    return [...targetAlternatives(node.left), ...targetAlternatives(node.right)];
  }
  if (node.type === 'SequenceExpression') return targetAlternatives(node.expressions.at(-1));
  return [node];
}

function resolvedTargetNode(node, bindings) {
  if (node?.type !== 'MemberExpression' || !node.computed) return node;
  const objects = staticBoundNodes(node.object, bindings);
  const index =
    node.property?.type === 'Literal' && Number.isSafeInteger(node.property.value)
      ? node.property.value
      : undefined;
  if (index === undefined) return node;
  const array = objects.find((candidate) => candidate.type === 'ArrayExpression');
  return array?.elements?.[index] ?? node;
}

function targetSourceGroups(node, bindings, compound = false, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return [];
  const nextSeen = new Set(seen).add(node);
  const resolved = resolvedTargetNode(node, bindings);
  if (resolved !== node) return targetSourceGroups(resolved, bindings, compound, nextSeen);
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
    return targetAlternatives(node).flatMap((alternative) =>
      targetSourceGroups(alternative, bindings, compound, nextSeen),
    );
  }
  if (node.type === 'SequenceExpression') {
    return targetSourceGroups(node.expressions.at(-1), bindings, compound, nextSeen);
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return [
      ...targetSourceGroups(node.left, bindings, true, nextSeen),
      ...targetSourceGroups(node.right, bindings, true, nextSeen),
    ];
  }
  if (node.type === 'TemplateLiteral') {
    return node.expressions.flatMap((expression, index) =>
      targetSourceGroups(expression, bindings, index > 0, nextSeen),
    );
  }
  if (node.type === 'MemberExpression') {
    const properties = memberPropertyNames(node, bindings);
    if (
      properties.some((property) =>
        [
          'hash',
          'host',
          'hostname',
          'href',
          'origin',
          'pathname',
          'port',
          'protocol',
          'search',
        ].includes(property),
      )
    ) {
      return targetSourceGroups(node.object, bindings, compound, nextSeen);
    }
    if (properties.length > 0) return [properties];
    return targetSourceGroups(node.object, bindings, compound, nextSeen);
  }
  if (node.type === 'NewExpression') {
    const constructors = calleeNames(node.callee, bindings);
    if (constructors.includes('URL')) {
      const [pathOrUrl, baseUrl] = node.arguments ?? [];
      if (baseUrl) {
        const baseGroups = targetSourceGroups(baseUrl, bindings, compound, nextSeen);
        const pathGroups = isSyntacticallyRelativeTarget(pathOrUrl, bindings)
          ? []
          : targetSourceGroups(pathOrUrl, bindings, true, nextSeen);
        return [...baseGroups, ...pathGroups];
      }
      return targetSourceGroups(pathOrUrl, bindings, compound, nextSeen);
    }
  }
  if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
    const methods = memberPropertyNames(node.callee, bindings);
    if (methods.some((method) => ['replace', 'toString', 'trim'].includes(method))) {
      return targetSourceGroups(node.callee.object, bindings, compound, nextSeen);
    }
  }
  if (
    node.type === 'CallExpression' &&
    calleeNames(node.callee, bindings).some((name) => ['String'].includes(name))
  ) {
    return targetSourceGroups(node.arguments?.[0], bindings, compound, nextSeen);
  }
  if (node.type === 'CallExpression') {
    const argumentGroups = (node.arguments ?? []).flatMap((argument) =>
      targetSourceGroups(argument, bindings, true, nextSeen),
    );
    if (argumentGroups.length > 0) return argumentGroups;
    return [];
  }
  if (node.type === 'Identifier') {
    const initializers = bindingValues(bindings, node);
    if (initializers.length > 0) {
      const traced = initializers.flatMap((initializer) =>
        targetSourceGroups(initializer, bindings, compound, nextSeen),
      );
      if (traced.length > 0) return traced;
    }
    if (compound && /(?:^|_)(?:id|key|path|query|route|slug|token)$/iu.test(node.name)) return [];
    return [[node.name]];
  }
  if (node.type === 'Literal' || node.type === 'StringLiteral') return [];
  return [[...networkTargetSources(node, bindings)]];
}

function isSafeRelativeConstituent(node, bindings) {
  if (isSyntacticallyRelativeTarget(node, bindings)) return true;
  return (
    node?.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' &&
    ['encodeURI', 'encodeURIComponent'].includes(node.callee.name) &&
    bindingValues(bindings, node.callee).length === 0 &&
    bindings.resolveSymbolIdentity?.(node.callee) === undefined &&
    node.arguments?.length === 1
  );
}

function targetAuthority(node, bindings, authorities, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  const nextSeen = new Set(seen).add(node);
  const resolved = resolvedTargetNode(node, bindings);
  if (resolved !== node) return targetAuthority(resolved, bindings, authorities, nextSeen);
  if (node.type === 'Identifier') {
    const initializers = bindingValues(bindings, node);
    if (initializers.length === 0) return;
    const resolvedAuthorities = initializers.map((initializer) =>
      targetAuthority(initializer, bindings, authorities, nextSeen),
    );
    if (
      resolvedAuthorities.length > 0 &&
      resolvedAuthorities.every(
        (authority) => authority?.id === resolvedAuthorities[0]?.id && authority !== undefined,
      )
    ) {
      return resolvedAuthorities[0];
    }
    return;
  }
  if (
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TypeCastExpression' ||
    node.type === 'AwaitExpression'
  ) {
    return targetAuthority(node.expression ?? node.argument, bindings, authorities, nextSeen);
  }
  if (node.type === 'SequenceExpression') {
    return targetAuthority(node.expressions.at(-1), bindings, authorities, nextSeen);
  }
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
    const alternatives =
      node.type === 'ConditionalExpression'
        ? [node.consequent, node.alternate]
        : [node.left, node.right];
    const resolvedAuthorities = alternatives.map((alternative) =>
      targetAuthority(alternative, bindings, authorities, nextSeen),
    );
    if (
      resolvedAuthorities.every(
        (authority) => authority?.id === resolvedAuthorities[0]?.id && authority !== undefined,
      )
    ) {
      return resolvedAuthorities[0];
    }
    return;
  }
  if (node.type === 'CallExpression') {
    const identity = bindings.resolveSymbolIdentity?.(node.callee);
    const issued = authorityForIdentity(authorities, identity);
    if (issued) return issued;
    if (node.callee?.type === 'Identifier') {
      const returns = bindings.localFunctionReturns?.get(node.callee.name) ?? [];
      const materialReturns = returns.filter(
        (value) =>
          !(
            (value.type === 'Identifier' && value.name === 'undefined') ||
            ((value.type === 'Literal' || value.type === 'NullLiteral') && value.value === null)
          ),
      );
      const returnAuthorities = materialReturns.map((value) =>
        targetAuthority(value, bindings, authorities, nextSeen),
      );
      if (
        returnAuthorities.length > 0 &&
        returnAuthorities.every(
          (authority) => authority?.id === returnAuthorities[0]?.id && authority !== undefined,
        )
      ) {
        return returnAuthorities[0];
      }
    }
    if (node.callee?.type === 'MemberExpression') {
      const methods = memberPropertyNames(node.callee, bindings);
      if (methods.some((method) => ['replace', 'toString', 'trim'].includes(method))) {
        return targetAuthority(node.callee.object, bindings, authorities, nextSeen);
      }
    }
    return;
  }
  if (node.type === 'NewExpression' && calleeNames(node.callee, bindings).includes('URL')) {
    const [pathOrUrl, baseUrl] = node.arguments ?? [];
    if (baseUrl) {
      if (!isSyntacticallyRelativeTarget(pathOrUrl, bindings)) return;
      return targetAuthority(baseUrl, bindings, authorities, nextSeen);
    }
    return targetAuthority(pathOrUrl, bindings, authorities, nextSeen);
  }
  if (node.type === 'MemberExpression') {
    if (bindings.isMutated?.(node.object)) return;
    const authority = targetAuthority(node.object, bindings, authorities, nextSeen);
    if (!authority) return;
    return ['url-properties', 'url-property'].includes(authority.outputShape)
      ? authority
      : undefined;
  }
  if (node.type === 'ObjectExpression') {
    const targetKeys = new Set([
      'endpoint',
      'host',
      'hostname',
      'href',
      'origin',
      'path',
      'port',
      'protocol',
      'uri',
      'url',
    ]);
    const resolvedAuthorities = [];
    for (const property of node.properties ?? []) {
      if (property.type === 'SpreadElement') return;
      if (property.type !== 'Property') continue;
      const keys = property.computed
        ? staticStrings(property.key, bindings)
        : [property.key?.name ?? property.key?.value].filter(Boolean);
      if (!keys.some((key) => targetKeys.has(key))) continue;
      const authority = targetAuthority(property.value, bindings, authorities, nextSeen);
      if (authority) {
        resolvedAuthorities.push(authority);
        continue;
      }
      const staticValues = staticStrings(property.value, bindings);
      if (
        staticValues.length === 0 &&
        !(
          (property.value?.type === 'Literal' || property.value?.type === 'NumericLiteral') &&
          typeof property.value.value === 'number'
        )
      ) {
        return;
      }
    }
    if (
      resolvedAuthorities.length > 0 &&
      resolvedAuthorities.every((authority) => authority.id === resolvedAuthorities[0].id)
    ) {
      return resolvedAuthorities[0];
    }
    return;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = targetAuthority(node.left, bindings, authorities, nextSeen);
    const right = targetAuthority(node.right, bindings, authorities, nextSeen);
    if (left && !right && isSafeRelativeConstituent(node.right, bindings)) return left;
    if (right && !left && isSafeRelativeConstituent(node.left, bindings)) return right;
    return left?.id === right?.id ? left : undefined;
  }
  if (node.type === 'TemplateLiteral') {
    let authority;
    for (const expression of node.expressions) {
      const candidate = targetAuthority(expression, bindings, authorities, nextSeen);
      if (!candidate) {
        if (!isSafeRelativeConstituent(expression, bindings)) return;
        continue;
      }
      if (authority && authority.id !== candidate.id) return;
      authority = candidate;
    }
    return authority;
  }
  return;
}

function networkExecutionMethod(node, bindings) {
  const memberMethods =
    node.callee?.type === 'MemberExpression' ? memberPropertyNames(node.callee, bindings) : [];
  if (memberMethods.includes('delete')) return 'DELETE';
  if (memberMethods.includes('get')) return 'GET';
  if (memberMethods.includes('head')) return 'HEAD';
  if (memberMethods.includes('options')) return 'OPTIONS';
  if (memberMethods.includes('patch')) return 'PATCH';
  if (memberMethods.includes('post') || memberMethods.includes('push')) return 'POST';
  if (memberMethods.includes('put')) return 'PUT';
  if (memberMethods.includes('sendBeacon')) return 'POST';
  if (
    memberMethods.includes('open') &&
    node.callee?.type === 'MemberExpression' &&
    bindingValues(bindings, node.callee.object).some(
      (candidate) =>
        candidate?.type === 'NewExpression' &&
        calleeNames(candidate.callee, bindings).includes('XMLHttpRequest'),
    )
  ) {
    const methods = staticStrings(node.arguments?.[0], bindings).map((method) =>
      method.toUpperCase(),
    );
    return methods.length === 1 ? methods[0] : undefined;
  }
  const options = node.arguments?.find((argument) => argument?.type === 'ObjectExpression');
  if (options) {
    let declaresMethod = false;
    for (const property of options.properties ?? []) {
      if (property.type !== 'Property') continue;
      const keys = property.computed
        ? staticStrings(property.key, bindings)
        : [property.key?.name ?? property.key?.value].filter(Boolean);
      if (!keys.includes('method')) continue;
      declaresMethod = true;
      const methods = staticStrings(property.value, bindings).map((method) => method.toUpperCase());
      if (methods.length === 1) return methods[0];
    }
    if (declaresMethod) return '*';
  }
  return 'GET';
}

function isKnownNonNetworkReadReceiver(
  node,
  bindings,
  shadowedBuiltinCollections,
  knownCollectionFactories = new Set(),
  seen = new Set(),
  accessedMethods = [],
) {
  if (!node || typeof node !== 'object' || seen.has(node)) return false;
  if (
    typeof bindings.isKnownNonNetworkReceiver === 'function' &&
    bindings.isKnownNonNetworkReceiver(node, accessedMethods)
  ) {
    return true;
  }
  const nextSeen = new Set(seen).add(node);
  if (
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TypeCastExpression'
  ) {
    return isKnownNonNetworkReadReceiver(
      node.expression,
      bindings,
      shadowedBuiltinCollections,
      knownCollectionFactories,
      nextSeen,
      accessedMethods,
    );
  }
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
    const alternatives =
      node.type === 'ConditionalExpression'
        ? [node.consequent, node.alternate]
        : [node.left, node.right];
    return alternatives.every((alternative) =>
      isKnownNonNetworkReadReceiver(
        alternative,
        bindings,
        shadowedBuiltinCollections,
        knownCollectionFactories,
        nextSeen,
        accessedMethods,
      ),
    );
  }
  if (node.type === 'Identifier') {
    const initializers = bindingValues(bindings, node);
    return (
      initializers.length > 0 &&
      initializers.every((initializer) =>
        isKnownNonNetworkReadReceiver(
          initializer,
          bindings,
          shadowedBuiltinCollections,
          knownCollectionFactories,
          nextSeen,
          accessedMethods,
        ),
      )
    );
  }
  if (node.type === 'AwaitExpression') {
    return isKnownNonNetworkReadReceiver(
      node.argument,
      bindings,
      shadowedBuiltinCollections,
      knownCollectionFactories,
      nextSeen,
      accessedMethods,
    );
  }
  if (
    node.type === 'CallExpression' &&
    calleeNames(node.callee, bindings).some((name) => knownCollectionFactories.has(name))
  ) {
    return true;
  }
  if (
    node.type === 'CallExpression' &&
    syntaxContainsBuiltinCollectionConstruction(node.arguments)
  ) {
    return true;
  }
  if (
    node.type === 'MemberExpression' &&
    node.computed &&
    node.property?.type === 'Literal' &&
    Number.isSafeInteger(node.property.value) &&
    (node.object?.type === 'CallExpression' || node.object?.type === 'AwaitExpression')
  ) {
    const promiseCall = node.object.type === 'AwaitExpression' ? node.object.argument : node.object;
    if (
      promiseCall?.type === 'CallExpression' &&
      promiseCall.callee?.type === 'MemberExpression' &&
      promiseCall.callee.object?.type === 'Identifier' &&
      promiseCall.callee.object.name === 'Promise' &&
      memberPropertyNames(promiseCall.callee, bindings).includes('all') &&
      promiseCall.arguments?.[0]?.type === 'ArrayExpression'
    ) {
      const element = promiseCall.arguments[0].elements?.[node.property.value];
      return isKnownNonNetworkReadReceiver(
        element,
        bindings,
        shadowedBuiltinCollections,
        knownCollectionFactories,
        nextSeen,
        accessedMethods,
      );
    }
  }
  if (
    node.type === 'MemberExpression' &&
    isKnownNonNetworkReadReceiver(
      node.object,
      bindings,
      shadowedBuiltinCollections,
      knownCollectionFactories,
      nextSeen,
      accessedMethods,
    )
  ) {
    return true;
  }
  if (
    node.type === 'NewExpression' &&
    ((node.callee?.type === 'Identifier' &&
      ['Headers', 'Map', 'Set', 'URLSearchParams', 'WeakMap', 'WeakSet'].includes(
        node.callee.name,
      ) &&
      !shadowedBuiltinCollections.has(node.callee.name)) ||
      (node.callee?.type === 'MemberExpression' &&
        node.callee.object?.type === 'Identifier' &&
        node.callee.object.name === 'globalThis' &&
        !shadowedBuiltinCollections.has('globalThis') &&
        memberPropertyNames(node.callee, bindings).some((name) =>
          ['Headers', 'Map', 'Set', 'URLSearchParams', 'WeakMap', 'WeakSet'].includes(name),
        )))
  ) {
    return true;
  }
  return false;
}

function executorRequestTargets(node, bindings) {
  const targets = [];
  for (const candidate of staticBoundNodes(node, bindings)) {
    if (candidate.type !== 'ObjectExpression') continue;
    for (const property of candidate.properties ?? []) {
      if (property.type !== 'Property') continue;
      const keys = property.computed
        ? staticStrings(property.key, bindings)
        : [property.key?.name ?? property.key?.value].filter(Boolean);
      if (keys.some((key) => ['endpoint', 'href', 'uri', 'url'].includes(key))) {
        targets.push(...targetAlternatives(property.value));
      }
    }
  }
  return targets.length > 0 ? targets : targetAlternatives(node);
}

function containingExportedFunction(node, parents) {
  let current = node;
  while ((current = parents.get(current))) {
    if (current.type !== 'FunctionDeclaration') continue;
    const parent = parents.get(current);
    return parent?.type === 'ExportNamedDeclaration' ? current.id?.name : undefined;
  }
}

function isReflectApply(expression, bindings) {
  return (
    expression?.type === 'MemberExpression' &&
    expression.object?.type === 'Identifier' &&
    expression.object.name === 'Reflect' &&
    memberPropertyNames(expression, bindings).includes('apply')
  );
}

function providerHosts(value) {
  const hosts = [];
  for (const match of value.matchAll(/(?:https?|wss?):\/\/[A-Za-z0-9.-]+/giu)) {
    try {
      hosts.push(new URL(match[0]).hostname.toLowerCase());
    } catch {
      // A malformed literal is not an executable provider endpoint.
    }
  }
  return hosts;
}

function sourceMayContainProviderBoundary(
  source,
  hostPolicies,
  importPolicies,
  transportExecutorPolicies = new Map(),
) {
  const decoded = source
    .replace(/\\x([0-9a-f]{2})/giu, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/giu, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (_match, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
  const compact = decoded.replace(/[^a-z0-9]/giu, '').toLowerCase();
  return (
    [...hostPolicies.keys()].some((host) => compact.includes(host)) ||
    [...importPolicies.keys()].some((packageName) =>
      compact.includes(packageName.replace(/[^a-z0-9]/giu, '').toLowerCase()),
    ) ||
    [...transportExecutorPolicies.keys()].some((executor) => decoded.includes(executor)) ||
    compact.includes('globalthisfetch') ||
    compact.includes('navigatorbeacon') ||
    compact.includes('navigatorsendbeacon') ||
    compact.includes('modulerequire') ||
    (decoded.includes('[') &&
      ['get', 'head', 'options'].some((method) => compact.includes(method))) ||
    /(?:\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\()/u.test(decoded) ||
    /(?:from\s*['"](?:node:)?https?['"]|from\s*['"]undici['"])/u.test(decoded) ||
    /(?:\bcreateRequire\b|\bEventSource\b|\bfetch\b|\brequire\b|\bimport\s*\(|\bWebSocket\b|\bXMLHttpRequest\b|\.(?:delete|fetch|get|head|options|patch|post|put|request|sendBeacon)\s*\()/u.test(
      decoded,
    ) ||
    ((decoded.includes('fromCharCode') || decoded.includes('fromCodePoint')) &&
      /(?:fetch|import|require|request)/u.test(decoded))
  );
}

function syntaxContainsDependencyTaint(node, packageName, values = []) {
  if (!node || typeof node !== 'object') return false;
  if (
    (node.type === 'Literal' || node.type === 'StringLiteral') &&
    typeof node.value === 'string'
  ) {
    values.push(node.value);
  }
  if (node.type === 'TemplateElement') {
    values.push(node.value?.cooked ?? node.value?.raw ?? '');
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'scope') continue;
    if (Array.isArray(value)) {
      for (const entry of value) syntaxContainsDependencyTaint(entry, packageName, values);
    } else {
      syntaxContainsDependencyTaint(value, packageName, values);
    }
  }
  const normalized = values
    .join('')
    .replace(/[^a-z0-9]/giu, '')
    .toLowerCase();
  const normalizedPackage = packageName.replace(/[^a-z0-9]/giu, '').toLowerCase();
  return normalized.includes(normalizedPackage);
}

function syntaxContainsIdentifier(node, name, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return false;
  seen.add(node);
  if (node.type === 'Identifier' && node.name === name) return true;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'scope') continue;
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (syntaxContainsIdentifier(child, name, seen)) return true;
    }
  }
  return false;
}

function syntaxContainsBuiltinCollectionConstruction(node, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return false;
  seen.add(node);
  if (
    node.type === 'NewExpression' &&
    node.callee?.type === 'Identifier' &&
    ['Headers', 'Map', 'Set', 'URLSearchParams', 'WeakMap', 'WeakSet'].includes(node.callee.name)
  ) {
    return true;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'scope') continue;
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (syntaxContainsBuiltinCollectionConstruction(child, seen)) return true;
    }
  }
  return false;
}

function isAllowedNonExecutionHostLiteral(path, node, parents, allowedPaths) {
  if (!allowedPaths.some((pattern) => pathMatchesPolicy(path, pattern))) return false;
  let current = node;
  let returned = false;
  while ((current = parents.get(current))) {
    if (current.type === 'ReturnStatement') returned = true;
    if (
      current.type === 'CallExpression' &&
      !(
        current.callee?.type === 'MemberExpression' &&
        !current.callee.computed &&
        (current.callee.property?.name === 'trim' || current.callee.property?.name === 'join')
      )
    )
      return false;
    if (
      current.type === 'FunctionDeclaration' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      return returned;
    }
  }
  return false;
}

export function providerSourceBoundaryFindings(
  path,
  source,
  hostPolicies,
  importPolicies,
  nonProviderHostPolicies,
  transportExecutors = new Map(),
  transportExecutorPolicies = new Map(),
  networkTargetAuthorities = new Map(),
  safeCollectionFactoryIdentities = new Set(),
  nonNetworkReceiverTypes = new Map(),
  availableWorkspaceModulePaths = new Set([path]),
) {
  if (
    !sourceMayContainProviderBoundary(
      source,
      hostPolicies,
      importPolicies,
      transportExecutorPolicies,
    )
  ) {
    return {
      hosts: [],
      sdkPackages: [],
      unknownHosts: [],
      unresolvedDynamicLoads: false,
      unapprovedDynamicNetwork: false,
      unapprovedProviderNetwork: false,
      dynamicNetworkEnvironmentVariables: [],
      dynamicNetworkTargetKinds: [],
      dynamicNetworkTargetSources: [],
      dynamicNetworkTargets: [],
      unapprovedTransportExecutorUse: false,
    };
  }
  const parsed = parseSync(path, source, { preserveParens: true });
  if (parsed.errors.length > 0) {
    throw new Error(`Unable to parse ${path} while validating provider boundaries`);
  }
  const sourceFile = parsed.program;
  const currentSourceSha256 = sourceSha256(source);
  const bindings = new Map();
  const parents = new WeakMap();
  const bindingScopes = new WeakMap();
  const importedSymbolIdentities = new Map();
  const localExportIdentities = new Map();
  const localFunctionReturns = new Map();
  const mutatedBindings = new Set();
  bindings.localFunctionReturns = localFunctionReturns;
  bindings.isMutated = (expression, seen = new Set()) => {
    if (!expression || typeof expression !== 'object' || seen.has(expression)) return false;
    seen.add(expression);
    if (expression.type === 'Identifier') {
      if (mutatedBindings.has(expression.name)) return true;
      return bindingValues(bindings, expression).some((initializer) =>
        bindings.isMutated(initializer, seen),
      );
    }
    if (expression.type === 'MemberExpression') return bindings.isMutated(expression.object, seen);
    return false;
  };
  const findings = {
    hosts: new Set(),
    sdkPackages: new Set(),
    unknownHosts: new Set(),
    unresolvedDynamicLoads: false,
    unapprovedDynamicNetwork: false,
    unapprovedProviderNetwork: false,
    dynamicNetworkEnvironmentVariables: new Set(),
    dynamicNetworkTargetKinds: new Set(),
    dynamicNetworkTargetSources: new Set(),
    dynamicNetworkTargets: [],
    unapprovedTransportExecutorUse: false,
  };
  const nonExecutionHostsSeen = new Set();

  const walk = (node, visitor, parent, seen = new WeakSet()) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (parent) parents.set(node, parent);
    if (typeof node.type === 'string') visitor(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent' || key === 'scope') continue;
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry, visitor, node, seen);
      } else {
        walk(value, visitor, node, seen);
      }
    }
  };
  const lexicalScope = (node) => {
    let current = node;
    while (current) {
      if (
        current === sourceFile ||
        current.type === 'FunctionDeclaration' ||
        current.type === 'FunctionExpression' ||
        current.type === 'ArrowFunctionExpression'
      ) {
        return current;
      }
      current = parents.get(current);
    }
    return sourceFile;
  };
  bindings.resolve = (reference) => {
    const values = bindings.get(reference.name) ?? [];
    if (values.length === 0) return [];
    let scope = lexicalScope(reference);
    while (scope) {
      const scoped = values.filter((value) => bindingScopes.get(value)?.has(scope));
      if (scoped.length > 0) return [...new Set(scoped)];
      scope = scope === sourceFile ? undefined : lexicalScope(parents.get(scope));
    }
    return [];
  };
  bindings.resolveSymbolIdentity = (expression, seen = new Set()) => {
    if (!expression || typeof expression !== 'object' || seen.has(expression)) return;
    const nextSeen = new Set(seen).add(expression);
    if (expression.type === 'Identifier') {
      const initializers = bindingValues(bindings, expression);
      if (initializers.length > 0) {
        const identities = initializers
          .map((initializer) => bindings.resolveSymbolIdentity(initializer, nextSeen))
          .filter(Boolean);
        return identities.length > 0 && identities.every((identity) => identity === identities[0])
          ? identities[0]
          : undefined;
      }
      return (
        localExportIdentities.get(expression.name) ?? importedSymbolIdentities.get(expression.name)
      );
    }
    if (expression.type === 'MemberExpression') {
      const properties = memberPropertyNames(expression, bindings);
      if (properties.length !== 1 || expression.object?.type !== 'Identifier') return;
      const namespace = importedSymbolIdentities.get(expression.object.name);
      if (!namespace || namespace.export !== '*') return;
      return { ...namespace, export: properties[0] };
    }
    if (
      expression.type === 'ParenthesizedExpression' ||
      expression.type === 'TSAsExpression' ||
      expression.type === 'TSSatisfiesExpression' ||
      expression.type === 'TSNonNullExpression' ||
      expression.type === 'TypeCastExpression'
    ) {
      return bindings.resolveSymbolIdentity(expression.expression, nextSeen);
    }
    return;
  };
  const typeDeclaresCollectionProperty = (node, propertyName, seen = new Set()) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    if (node.type === 'TSTypeReference' && node.typeName?.type === 'Identifier') {
      if (safeObjectTypeProperties.get(node.typeName.name)?.has(propertyName)) return true;
    }
    if (node.type === 'TSPropertySignature') {
      const keys = node.computed
        ? staticStrings(node.key, bindings)
        : [node.key?.name ?? node.key?.value].filter(Boolean);
      if (
        keys.includes(propertyName) &&
        [
          'Headers',
          'Map',
          'ReadonlyMap',
          'ReadonlySet',
          'ReadonlyURLSearchParams',
          'Set',
          'URLSearchParams',
          'WeakMap',
          'WeakSet',
        ].some((name) => syntaxContainsIdentifier(node.typeAnnotation, name))
      ) {
        return true;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent' || key === 'scope') continue;
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (typeDeclaresCollectionProperty(child, propertyName, seen)) return true;
      }
    }
    return false;
  };
  const builtinTypeMethods = new Map([
    ['FormData', new Set(['get', 'getAll', 'has'])],
    ['Headers', new Set(['delete', 'get', 'has', 'set'])],
    ['Map', new Set(['delete', 'get', 'has', 'set'])],
    ['ReadonlyMap', new Set(['get', 'has'])],
    ['ReadonlySet', new Set(['has'])],
    ['ReadonlyURLSearchParams', new Set(['get', 'getAll', 'has'])],
    ['Set', new Set(['delete', 'has'])],
    ['URLSearchParams', new Set(['delete', 'get', 'getAll', 'has', 'set'])],
    ['WeakMap', new Set(['delete', 'get', 'has', 'set'])],
    ['WeakSet', new Set(['delete', 'has'])],
  ]);
  const typeSupportsMethods = (node, methods, seen = new Set()) => {
    if (!node || typeof node !== 'object' || seen.has(node) || methods.length === 0) return false;
    seen.add(node);
    if (node.type === 'TSTypeAnnotation') {
      return typeSupportsMethods(node.typeAnnotation, methods, seen);
    }
    if (node.type === 'TSTypeAliasDeclaration') {
      return typeSupportsMethods(node.typeAnnotation, methods, seen);
    }
    if (node.type === 'TSUnionType') {
      const materialTypes = (node.types ?? []).filter(
        (typeNode) =>
          typeNode.type !== 'TSNullKeyword' &&
          typeNode.type !== 'TSUndefinedKeyword' &&
          typeNode.type !== 'TSVoidKeyword',
      );
      return (
        materialTypes.length > 0 &&
        materialTypes.every((typeNode) => typeSupportsMethods(typeNode, methods, seen))
      );
    }
    if (node.type === 'TSTypeReference' && node.typeName?.type === 'Identifier') {
      const builtin = builtinTypeMethods.get(node.typeName.name);
      if (builtin && methods.every((method) => builtin.has(method))) return true;
      const declaration = localTypeDeclarations.get(node.typeName.name);
      if (declaration?.type === 'TSTypeAliasDeclaration') {
        return typeSupportsMethods(declaration, methods, seen);
      }
      const receiver = nonNetworkReceiverTypes.get(`${path}#${node.typeName.name}`);
      return (
        receiver?.sha256 === currentSourceSha256 &&
        methods.every((method) => receiver.allowedMethods.includes(method))
      );
    }
    const members =
      node.type === 'TSInterfaceDeclaration'
        ? (node.body?.body ?? [])
        : node.type === 'TSInterfaceBody'
          ? (node.body ?? [])
          : node.type === 'TSTypeLiteral'
            ? (node.members ?? [])
            : [];
    if (members.length > 0) return false;
    return false;
  };
  const typePropertySupportsMethods = (node, propertyName, methods, seen = new Set()) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    if (node.type === 'TSTypeAnnotation') {
      return typePropertySupportsMethods(node.typeAnnotation, propertyName, methods, seen);
    }
    if (node.type === 'TSTypeReference' && node.typeName?.type === 'Identifier') {
      const receiver = nonNetworkReceiverTypes.get(`${path}#${node.typeName.name}`);
      if (
        receiver?.sha256 === currentSourceSha256 &&
        methods.every((method) => receiver.allowedMethods.includes(method))
      ) {
        return true;
      }
      return typePropertySupportsMethods(
        localTypeDeclarations.get(node.typeName.name),
        propertyName,
        methods,
        seen,
      );
    }
    const members =
      node.type === 'TSInterfaceDeclaration'
        ? (node.body?.body ?? [])
        : node.type === 'TSInterfaceBody'
          ? (node.body ?? [])
          : node.type === 'TSTypeLiteral'
            ? (node.members ?? [])
            : [];
    for (const member of members) {
      if (member.type !== 'TSPropertySignature') continue;
      const keys = member.computed
        ? staticStrings(member.key, bindings)
        : [member.key?.name ?? member.key?.value].filter(Boolean);
      if (keys.includes(propertyName) && typeSupportsMethods(member.typeAnnotation, methods)) {
        return true;
      }
    }
    return false;
  };
  bindings.isKnownNonNetworkReceiver = (reference, accessedMethods = []) => {
    const scopes = [];
    let scope = lexicalScope(reference);
    while (scope) {
      scopes.push(scope);
      scope = scope === sourceFile ? undefined : lexicalScope(parents.get(scope));
    }
    const typeIsCollection = (typeNode) =>
      [...safeNonNetworkTypeNames].some((name) => syntaxContainsIdentifier(typeNode, name));
    if (reference.type === 'Identifier') {
      if (
        scopes.some((candidateScope) =>
          safeCollectionBindings.get(candidateScope)?.has(reference.name),
        )
      ) {
        return true;
      }
      return scopes.some((candidateScope) =>
        (candidateScope.params ?? []).some((parameter) => {
          const target = parameter.type === 'AssignmentPattern' ? parameter.left : parameter;
          if (target.type === 'ObjectPattern') {
            const bindsReference = (target.properties ?? []).some(
              (property) =>
                property.type === 'Property' &&
                property.value?.type === 'Identifier' &&
                property.value.name === reference.name,
            );
            return (
              bindsReference &&
              (typeDeclaresCollectionProperty(target.typeAnnotation, reference.name) ||
                typePropertySupportsMethods(target.typeAnnotation, reference.name, accessedMethods))
            );
          }
          return (
            target.type === 'Identifier' &&
            target.name === reference.name &&
            (typeIsCollection(target.typeAnnotation) ||
              typeSupportsMethods(target.typeAnnotation, accessedMethods) ||
              (parameter.type === 'AssignmentPattern' &&
                syntaxContainsBuiltinCollectionConstruction(parameter.right)))
          );
        }),
      );
    }
    if (reference.type === 'CallExpression') {
      if (
        calleeNames(reference.callee, bindings).some((name) => safeNonNetworkFactoryNames.has(name))
      ) {
        return true;
      }
      if (
        reference.callee?.type === 'MemberExpression' &&
        reference.callee.object?.type === 'Identifier'
      ) {
        const methodNames = memberPropertyNames(reference.callee, bindings);
        if (methodNames.length === 1) {
          return scopes.some((candidateScope) =>
            (candidateScope.params ?? []).some((parameter) => {
              const target = parameter.type === 'AssignmentPattern' ? parameter.left : parameter;
              return (
                target.type === 'Identifier' &&
                target.name === reference.callee.object.name &&
                typeDeclaresCollectionProperty(target.typeAnnotation, methodNames[0])
              );
            }),
          );
        }
      }
      return false;
    }
    if (reference.type === 'NewExpression') {
      return calleeNames(reference.callee, bindings).some((name) =>
        safeNonNetworkConstructorNames.has(name),
      );
    }
    if (reference.type !== 'MemberExpression') return false;
    if (reference.object?.type === 'ThisExpression') {
      const propertyNames = memberPropertyNames(reference, bindings);
      let current = reference;
      while (current && current.type !== 'ClassDeclaration' && current.type !== 'ClassExpression') {
        current = parents.get(current);
      }
      if (current && propertyNames.length === 1) {
        return (current.body?.body ?? []).some((element) => {
          if (element.type !== 'PropertyDefinition') return false;
          const keys = element.computed
            ? staticStrings(element.key, bindings)
            : [element.key?.name ?? element.key?.value].filter(Boolean);
          return (
            keys.includes(propertyNames[0]) &&
            (syntaxContainsBuiltinCollectionConstruction(element.value) ||
              typeIsCollection(element.typeAnnotation))
          );
        });
      }
    }
    if (bindings.isKnownNonNetworkReceiver(reference.object)) return true;
    const propertyNames = memberPropertyNames(reference, bindings);
    if (propertyNames.length !== 1 || reference.object?.type !== 'Identifier') return false;
    if (
      propertyNames[0] === 'headers' &&
      scopes.some((candidateScope) =>
        contextualRequestBindings.get(candidateScope)?.has(reference.object.name),
      )
    ) {
      return true;
    }
    if (
      bindingValues(bindings, reference.object).some((initializer) => {
        if (initializer?.type !== 'CallExpression') return false;
        if (
          calleeNames(initializer.callee, bindings).some((name) =>
            safeObjectFactoryProperties.get(name)?.has(propertyNames[0]),
          )
        ) {
          return true;
        }
        if (
          initializer.callee?.type !== 'MemberExpression' ||
          !memberPropertyNames(initializer.callee, bindings).includes('get') ||
          initializer.callee.object?.type !== 'Identifier'
        ) {
          return false;
        }
        return safeCollectionValueProperties
          .get(initializer.callee.object.name)
          ?.has(propertyNames[0]);
      })
    ) {
      return true;
    }
    return scopes.some((candidateScope) =>
      (candidateScope.params ?? []).some((parameter) => {
        const target = parameter.type === 'AssignmentPattern' ? parameter.left : parameter;
        return (
          target.type === 'Identifier' &&
          target.name === reference.object.name &&
          (typeDeclaresCollectionProperty(target.typeAnnotation, propertyNames[0]) ||
            typePropertySupportsMethods(target.typeAnnotation, propertyNames[0], accessedMethods))
        );
      }),
    );
  };
  const bind = (name, value, owner = value) => {
    const values = bindings.get(name) ?? [];
    values.push(value);
    bindings.set(name, values);
    if (value && typeof value === 'object') {
      const scopes = bindingScopes.get(value) ?? new Set();
      scopes.add(lexicalScope(owner));
      bindingScopes.set(value, scopes);
    }
  };
  const bindPattern = (pattern, value, owner = pattern) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
      if (value) bind(pattern.name, value, owner);
      return;
    }
    if (pattern.type === 'AssignmentPattern') {
      bindPattern(pattern.left, value, owner);
      bindPattern(pattern.left, pattern.right, owner);
      return;
    }
    if (pattern.type === 'ArrayPattern') {
      for (const [index, element] of (pattern.elements ?? []).entries()) {
        if (!element) continue;
        const resolved =
          value?.type === 'ArrayExpression'
            ? value.elements?.[index]
            : {
                type: 'MemberExpression',
                object: value,
                property: { type: 'Literal', value: index },
                computed: true,
              };
        bindPattern(element, resolved, owner);
      }
      return;
    }
    if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties ?? []) {
        if (property.type !== 'Property') continue;
        bindPattern(
          property.value,
          {
            type: 'MemberExpression',
            object: value,
            property: property.key,
            computed: property.computed,
          },
          owner,
        );
      }
    }
  };
  const memberRootName = (node) => {
    let current = node;
    while (current?.type === 'MemberExpression') current = current.object;
    return current?.type === 'Identifier' ? current.name : undefined;
  };
  const createRequireFactories = new Set(['createRequire']);
  const moduleNamespaces = new Set();
  const dynamicRequireLoaders = new Set(['require']);
  const shadowedBuiltinCollections = new Set();
  const knownCollectionFactories = new Set();
  const safeCollectionBindings = new WeakMap();
  const safeObjectTypeProperties = new Map();
  const safeObjectFactoryProperties = new Map();
  const safeCollectionValueProperties = new Map();
  const localTypeDeclarations = new Map();
  const contextualRequestProperties = new Map();
  const contextualRequestBindings = new WeakMap();
  const safeNonNetworkTypeNames = new Set([
    'FormData',
    'Headers',
    'Map',
    'ReadonlyMap',
    'ReadonlySet',
    'ReadonlyURLSearchParams',
    'Set',
    'URLSearchParams',
    'WeakMap',
    'WeakSet',
  ]);
  const safeNonNetworkFactoryNames = new Set();
  const safeNonNetworkConstructorNames = new Set();
  const localFunctionNames = new Set();
  const recordBuiltinCollectionPattern = (pattern) => {
    if (!pattern) return;
    if (
      pattern.type === 'Identifier' &&
      (['Map', 'Set', 'WeakMap', 'WeakSet'].includes(pattern.name) || pattern.name === 'globalThis')
    ) {
      shadowedBuiltinCollections.add(pattern.name);
      return;
    }
    if (pattern.type === 'AssignmentPattern') {
      recordBuiltinCollectionPattern(pattern.left);
      return;
    }
    if (pattern.type === 'RestElement') {
      recordBuiltinCollectionPattern(pattern.argument);
      return;
    }
    if (pattern.type === 'ArrayPattern') {
      for (const element of pattern.elements ?? []) recordBuiltinCollectionPattern(element);
      return;
    }
    if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties ?? []) {
        if (property.type === 'Property') recordBuiltinCollectionPattern(property.value);
        else if (property.type === 'RestElement') recordBuiltinCollectionPattern(property.argument);
      }
    }
  };
  const directReturnValues = (functionNode) => {
    const values = [];
    const visit = (node, root = false) => {
      if (!node || typeof node !== 'object') return;
      if (
        !root &&
        (node.type === 'FunctionDeclaration' ||
          node.type === 'FunctionExpression' ||
          node.type === 'ArrowFunctionExpression')
      ) {
        return;
      }
      if (node.type === 'ReturnStatement' && node.argument) values.push(node.argument);
      for (const [key, value] of Object.entries(node)) {
        if (key === 'parent' || key === 'scope') continue;
        const children = Array.isArray(value) ? value : [value];
        for (const child of children) visit(child);
      }
    };
    visit(functionNode.body, true);
    return values;
  };
  walk(sourceFile, (node) => {
    if (
      (node.type === 'TSInterfaceDeclaration' || node.type === 'TSTypeAliasDeclaration') &&
      node.id?.name
    ) {
      localTypeDeclarations.set(node.id.name, node);
    }
    if (node.type === 'ImportDeclaration') {
      const importSources = staticStrings(node.source, bindings);
      const importSource = importSources.length === 1 ? importSources[0] : undefined;
      if (!importSource) return;
      for (const specifier of node.specifiers ?? []) {
        if (!specifier.local?.name) continue;
        const imported =
          specifier.type === 'ImportNamespaceSpecifier'
            ? '*'
            : specifier.type === 'ImportDefaultSpecifier'
              ? 'default'
              : (specifier.imported?.name ?? specifier.imported?.value);
        if (!imported) continue;
        const identity = importSource.startsWith('.')
          ? workspaceImportIdentity(path, importSource, imported, availableWorkspaceModulePaths)
          : { type: 'package-export', package: importSource, export: imported };
        importedSymbolIdentities.set(specifier.local.name, identity);
        if (safeCollectionFactoryIdentities.has(symbolIdentityKey(identity))) {
          safeNonNetworkFactoryNames.add(specifier.local.name);
        }
      }
    }
    if (node.type === 'ExportNamedDeclaration' && !node.source) {
      for (const specifier of node.specifiers ?? []) {
        const local = specifier.local?.name ?? specifier.local?.value;
        const exported = specifier.exported?.name ?? specifier.exported?.value;
        if (!local || !exported) continue;
        localExportIdentities.set(local, {
          type: 'workspace-export',
          path,
          export: exported,
        });
      }
    }
    if (
      (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') &&
      node.id?.name &&
      parents.get(node)?.type === 'ExportNamedDeclaration'
    ) {
      localExportIdentities.set(node.id.name, {
        type: 'workspace-export',
        path,
        export: node.id.name,
      });
    }
    if (node.type === 'FunctionDeclaration' && node.id?.name) {
      localFunctionReturns.set(node.id.name, directReturnValues(node));
    }
  });
  walk(sourceFile, (node) => {
    if (node.type === 'TSInterfaceDeclaration' && node.id?.name) {
      const properties = new Set();
      for (const element of node.body?.body ?? []) {
        if (element.type !== 'TSPropertySignature') continue;
        const keys = element.computed
          ? staticStrings(element.key, bindings)
          : [element.key?.name ?? element.key?.value].filter(Boolean);
        if (
          [...safeNonNetworkTypeNames].some((name) =>
            syntaxContainsIdentifier(element.typeAnnotation, name),
          )
        ) {
          for (const key of keys) properties.add(key);
        }
      }
      if (properties.size > 0) safeObjectTypeProperties.set(node.id.name, properties);
    }
    if (
      node.type === 'TSTypeAliasDeclaration' &&
      node.id?.name &&
      [...safeNonNetworkTypeNames].some((name) =>
        syntaxContainsIdentifier(node.typeAnnotation, name),
      )
    ) {
      safeNonNetworkTypeNames.add(node.id.name);
    }
    if (node.type === 'TSTypeAliasDeclaration' && node.id?.name) {
      const properties = new Set();
      const members =
        node.typeAnnotation?.type === 'TSTypeLiteral' ? (node.typeAnnotation.members ?? []) : [];
      for (const element of members) {
        if (element.type !== 'TSPropertySignature') continue;
        const keys = element.computed
          ? staticStrings(element.key, bindings)
          : [element.key?.name ?? element.key?.value].filter(Boolean);
        if (
          [...safeNonNetworkTypeNames].some((name) =>
            syntaxContainsIdentifier(element.typeAnnotation, name),
          )
        ) {
          for (const key of keys) properties.add(key);
        }
      }
      if (properties.size > 0) safeObjectTypeProperties.set(node.id.name, properties);
      const requestProperties = new Set();
      for (const parameter of node.typeAnnotation?.params ?? []) {
        const typeLiteral = parameter.typeAnnotation?.typeAnnotation;
        if (typeLiteral?.type !== 'TSTypeLiteral') continue;
        for (const member of typeLiteral.members ?? []) {
          if (
            member.type !== 'TSPropertySignature' ||
            !syntaxContainsIdentifier(member.typeAnnotation, 'Request')
          ) {
            continue;
          }
          const keys = member.computed
            ? staticStrings(member.key, bindings)
            : [member.key?.name ?? member.key?.value].filter(Boolean);
          for (const key of keys) requestProperties.add(key);
        }
      }
      if (requestProperties.size > 0) {
        contextualRequestProperties.set(node.id.name, requestProperties);
      }
    }
    if (
      node.type === 'ClassDeclaration' &&
      node.id?.name &&
      !containsDirectNetworkInvocation(node.body, bindings)
    ) {
      safeNonNetworkConstructorNames.add(node.id.name);
    }
    if (
      node.type === 'MethodDefinition' &&
      node.key &&
      node.value?.returnType &&
      [...safeNonNetworkTypeNames].some((name) =>
        syntaxContainsIdentifier(node.value.returnType, name),
      ) &&
      syntaxContainsBuiltinCollectionConstruction(node.value.body)
    ) {
      const names = node.computed
        ? staticStrings(node.key, bindings)
        : [node.key?.name ?? node.key?.value].filter(Boolean);
      for (const name of names) safeNonNetworkFactoryNames.add(name);
    }
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression') &&
      node.init.returnType &&
      [...safeNonNetworkTypeNames].some((name) =>
        syntaxContainsIdentifier(node.init.returnType, name),
      ) &&
      syntaxContainsBuiltinCollectionConstruction(node.init.body)
    ) {
      safeNonNetworkFactoryNames.add(node.id.name);
    }
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      (syntaxContainsBuiltinCollectionConstruction(node.init) ||
        [...safeNonNetworkTypeNames].some((name) =>
          syntaxContainsIdentifier(node.id.typeAnnotation, name),
        ))
    ) {
      const scopeBindings = safeCollectionBindings.get(lexicalScope(node)) ?? new Set();
      scopeBindings.add(node.id.name);
      safeCollectionBindings.set(lexicalScope(node), scopeBindings);
    }
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      node.init?.type === 'NewExpression' &&
      calleeNames(node.init.callee, bindings).some((name) => name === 'Map' || name === 'WeakMap')
    ) {
      const valueType = node.init.typeArguments?.params?.[1];
      if (valueType?.type === 'TSTypeReference' && valueType.typeName?.type === 'Identifier') {
        const properties = safeObjectTypeProperties.get(valueType.typeName.name);
        if (properties) safeCollectionValueProperties.set(node.id.name, new Set(properties));
      }
    }
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      let owner = parents.get(node);
      while (
        owner &&
        owner.type !== 'FunctionDeclaration' &&
        owner.type !== 'FunctionExpression' &&
        owner.type !== 'ArrowFunctionExpression'
      ) {
        owner = parents.get(owner);
      }
      const acceptedProperties = new Set();
      for (const [typeName, properties] of contextualRequestProperties) {
        if (owner?.returnType && syntaxContainsIdentifier(owner.returnType, typeName)) {
          for (const property of properties) acceptedProperties.add(property);
        }
      }
      if (acceptedProperties.size > 0) {
        const localBindings = new Set();
        for (const parameter of node.params ?? []) {
          const target = parameter.type === 'AssignmentPattern' ? parameter.left : parameter;
          if (target.type !== 'ObjectPattern') continue;
          for (const property of target.properties ?? []) {
            if (property.type !== 'Property') continue;
            const keys = property.computed
              ? staticStrings(property.key, bindings)
              : [property.key?.name ?? property.key?.value].filter(Boolean);
            const local = property.value?.type === 'Identifier' ? property.value.name : undefined;
            if (local && keys.some((key) => acceptedProperties.has(key))) {
              localBindings.add(local);
            }
          }
        }
        if (localBindings.size > 0) contextualRequestBindings.set(node, localBindings);
      }
    }
    if (node.type === 'FunctionDeclaration' && node.id?.name && node.returnType) {
      for (const [typeName, properties] of safeObjectTypeProperties) {
        if (syntaxContainsIdentifier(node.returnType, typeName)) {
          safeObjectFactoryProperties.set(node.id.name, new Set(properties));
        }
      }
    }
    if (node.type === 'VariableDeclarator') recordBuiltinCollectionPattern(node.id);
    if (node.type === 'AssignmentExpression') recordBuiltinCollectionPattern(node.left);
    if (node.type === 'CatchClause') recordBuiltinCollectionPattern(node.param);
    if (node.type === 'ImportDeclaration') {
      const importSources = staticStrings(node.source, bindings);
      const importSource = importSources.length === 1 ? importSources[0] : undefined;
      const importsTixkitDatabase = importSources.some(
        (importSource) => importSource === '@tixkit/db',
      );
      const importsSearchParams = importSources.some(
        (importSource) => importSource === 'next/navigation',
      );
      const importsEditorTypes = importSources.some((importSource) =>
        importSource.startsWith('@tiptap/'),
      );
      const importsTypedTixkitClient = importSources.some(
        (importSource) =>
          importSource === '@tixkit/js' ||
          importSource === './migration-jobs.js' ||
          importSource === './migration-jobs',
      );
      const importsLocalEnvironmentParser = importSources.some(
        (importSource) => importSource === './env.js' || importSource === './env',
      );
      const importsEventMediaQueries = importSources.some(
        (importSource) =>
          importSource === '../../services/event-media.js' ||
          importSource === '../../services/event-media',
      );
      for (const specifier of node.specifiers ?? []) {
        recordBuiltinCollectionPattern(specifier.local);
        if (importSource && specifier.local?.name) {
          const imported =
            specifier.type === 'ImportNamespaceSpecifier'
              ? '*'
              : specifier.type === 'ImportDefaultSpecifier'
                ? 'default'
                : (specifier.imported?.name ?? specifier.imported?.value);
          if (imported) {
            importedSymbolIdentities.set(
              specifier.local.name,
              importSource.startsWith('.')
                ? workspaceImportIdentity(
                    path,
                    importSource,
                    imported,
                    availableWorkspaceModulePaths,
                  )
                : { type: 'package-export', package: importSource, export: imported },
            );
          }
        }
        if (importsTixkitDatabase && specifier.local?.name) {
          safeNonNetworkConstructorNames.add(specifier.local.name);
          safeNonNetworkTypeNames.add(specifier.local.name);
        }
        if (
          importsSearchParams &&
          specifier.type === 'ImportSpecifier' &&
          (specifier.imported?.name ?? specifier.imported?.value) === 'useSearchParams' &&
          specifier.local?.name
        ) {
          safeNonNetworkFactoryNames.add(specifier.local.name);
        }
        if (importsEditorTypes && specifier.local?.name) {
          safeNonNetworkTypeNames.add(specifier.local.name);
        }
        if (importsTypedTixkitClient && specifier.local?.name) {
          safeNonNetworkTypeNames.add(specifier.local.name);
          safeNonNetworkConstructorNames.add(specifier.local.name);
        }
        if (
          importsLocalEnvironmentParser &&
          specifier.type === 'ImportSpecifier' &&
          (specifier.imported?.name ?? specifier.imported?.value) === 'parseEnvFile' &&
          specifier.local?.name
        ) {
          safeNonNetworkFactoryNames.add(specifier.local.name);
        }
        if (
          importsEventMediaQueries &&
          specifier.type === 'ImportSpecifier' &&
          (specifier.imported?.name ?? specifier.imported?.value) === 'loadEventMediaThumbnails' &&
          specifier.local?.name
        ) {
          safeNonNetworkFactoryNames.add(specifier.local.name);
        }
      }
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      recordBuiltinCollectionPattern(node.id);
    }
    if (
      (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') &&
      node.id?.name &&
      parents.get(node)?.type === 'ExportNamedDeclaration'
    ) {
      localExportIdentities.set(node.id.name, {
        type: 'workspace-export',
        path,
        export: node.id.name,
      });
    }
    if (node.type === 'FunctionDeclaration' && node.id?.name) {
      localFunctionNames.add(node.id.name);
      localFunctionReturns.set(node.id.name, directReturnValues(node));
    }
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      for (const parameter of node.params ?? []) {
        recordBuiltinCollectionPattern(parameter);
        const target = parameter.type === 'AssignmentPattern' ? parameter.left : parameter;
        bindPattern(target, { type: 'UnresolvedParameter' }, parameter);
        if (parameter.type === 'AssignmentPattern') {
          bindPattern(parameter.left, parameter.right, parameter);
        }
      }
    }
    if (
      node.type === 'FunctionDeclaration' &&
      node.id?.name &&
      node.returnType &&
      [...safeNonNetworkTypeNames].some((name) =>
        syntaxContainsIdentifier(node.returnType, name),
      ) &&
      syntaxContainsBuiltinCollectionConstruction(node.body)
    ) {
      knownCollectionFactories.add(node.id.name);
      safeNonNetworkFactoryNames.add(node.id.name);
    }
    if (node.type === 'VariableDeclarator' && node.init) {
      bindPattern(node.id, node.init);
    }
    if (node.type === 'AssignmentExpression' && node.operator === '=') {
      if (node.left?.type === 'MemberExpression') {
        const rootName = memberRootName(node.left);
        if (rootName) mutatedBindings.add(rootName);
      }
      bindPattern(node.left, node.right);
    }
    if (node.type === 'UpdateExpression' && node.argument?.type === 'MemberExpression') {
      const rootName = memberRootName(node.argument);
      if (rootName) mutatedBindings.add(rootName);
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
      const methods = memberPropertyNames(node.callee, bindings);
      const mutatesFirstArgument =
        (node.callee.object?.type === 'Identifier' &&
          node.callee.object.name === 'Object' &&
          methods.includes('assign')) ||
        (node.callee.object?.type === 'Identifier' &&
          node.callee.object.name === 'Reflect' &&
          methods.includes('set'));
      if (mutatesFirstArgument) {
        const rootName = memberRootName(node.arguments?.[0]);
        if (rootName) mutatedBindings.add(rootName);
      }
    }
    if (
      node.type === 'ImportDeclaration' &&
      staticStrings(node.source, bindings).some(
        (source) => source === 'node:module' || source === 'module',
      )
    ) {
      for (const specifier of node.specifiers ?? []) {
        if (
          specifier.type === 'ImportSpecifier' &&
          specifier.imported?.name === 'createRequire' &&
          specifier.local?.name
        ) {
          createRequireFactories.add(specifier.local.name);
        }
        if (
          (specifier.type === 'ImportNamespaceSpecifier' ||
            specifier.type === 'ImportDefaultSpecifier') &&
          specifier.local?.name
        ) {
          moduleNamespaces.add(specifier.local.name);
        }
      }
    }
    if (node.type === 'ImportDeclaration') {
      const sources = staticStrings(node.source, bindings);
      const isHttp = sources.some((source) =>
        ['http', 'https', 'node:http', 'node:https'].includes(source),
      );
      const isFetchRuntime = sources.some((source) => source === 'undici');
      for (const specifier of node.specifiers ?? []) {
        if (
          specifier.type === 'ImportSpecifier' &&
          specifier.local?.name &&
          transportExecutorPolicies.has(specifier.imported?.name ?? specifier.imported?.value)
        ) {
          bind(specifier.local.name, {
            type: 'Identifier',
            name: specifier.imported?.name ?? specifier.imported?.value,
          });
        }
        if (
          (isHttp || isFetchRuntime) &&
          (specifier.type === 'ImportNamespaceSpecifier' ||
            specifier.type === 'ImportDefaultSpecifier') &&
          specifier.local?.name
        ) {
          bind(specifier.local.name, {
            type: 'Identifier',
            name: '__tixkitHttpNamespace',
          });
        }
        if (
          (isHttp || isFetchRuntime) &&
          specifier.type === 'ImportSpecifier' &&
          specifier.local?.name
        ) {
          const importedName = specifier.imported?.name ?? specifier.imported?.value;
          if (networkMethodNames.has(importedName)) {
            bind(specifier.local.name, {
              type: 'Identifier',
              name: importedName,
            });
          }
        }
      }
    }
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'ObjectPattern' &&
      node.init?.type === 'CallExpression' &&
      calleeNames(node.init.callee, bindings).includes('require') &&
      staticStrings(node.init.arguments?.[0], bindings).some(
        (source) => source === 'node:module' || source === 'module',
      )
    ) {
      for (const property of node.id.properties ?? []) {
        if (property.type !== 'Property' || property.value?.type !== 'Identifier') continue;
        const keys = property.computed
          ? staticStrings(property.key, bindings)
          : [property.key?.name ?? property.key?.value].filter(Boolean);
        if (keys.includes('createRequire')) createRequireFactories.add(property.value.name);
      }
    }
  });
  walk(sourceFile, (node) => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
      bind(node.id.name, node.init);
    }
    if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' && node.init) {
      for (const property of node.id.properties ?? []) {
        if (property.type !== 'Property' || property.value?.type !== 'Identifier') continue;
        const keys = property.computed
          ? staticStrings(property.key, bindings)
          : [property.key?.name ?? property.key?.value].filter(Boolean);
        if (keys.some((key) => networkMethodNames.has(key))) {
          bind(property.value.name, {
            type: 'MemberExpression',
            object: node.init,
            property: property.key,
            computed: property.computed,
          });
        }
        if (keys.some((key) => transportExecutorPolicies.has(key))) {
          bind(property.value.name, property.key);
        }
      }
    }
    if (
      node.type === 'AssignmentExpression' &&
      node.operator === '=' &&
      node.left?.type === 'ObjectPattern'
    ) {
      for (const property of node.left.properties ?? []) {
        if (property.type !== 'Property' || property.value?.type !== 'Identifier') continue;
        const keys = property.computed
          ? staticStrings(property.key, bindings)
          : [property.key?.name ?? property.key?.value].filter(Boolean);
        if (keys.some((key) => networkMethodNames.has(key))) {
          bind(property.value.name, {
            type: 'MemberExpression',
            object: node.right,
            property: property.key,
            computed: property.computed,
          });
        }
      }
    }
    if (
      node.type === 'AssignmentExpression' &&
      node.operator === '=' &&
      node.left?.type === 'Identifier'
    ) {
      bind(node.left.name, node.right);
    }
  });
  const loaderAssignments = [];
  walk(sourceFile, (node) => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
      loaderAssignments.push([node.id.name, node.init]);
    }
    if (
      node.type === 'AssignmentExpression' &&
      node.operator === '=' &&
      node.left?.type === 'Identifier'
    ) {
      loaderAssignments.push([node.left.name, node.right]);
    }
  });
  const createsRequireLoader = (expression) => {
    if (expression?.type !== 'CallExpression') return false;
    if (calleeNames(expression.callee, bindings).some((name) => createRequireFactories.has(name))) {
      return true;
    }
    return (
      expression.callee?.type === 'MemberExpression' &&
      expression.callee.object?.type === 'Identifier' &&
      moduleNamespaces.has(expression.callee.object.name) &&
      (expression.callee.computed
        ? staticStrings(expression.callee.property, bindings).includes('createRequire')
        : expression.callee.property?.name === 'createRequire')
    );
  };
  let loaderAdded = true;
  while (loaderAdded) {
    loaderAdded = false;
    for (const [name, expression] of loaderAssignments) {
      const aliasesLoader =
        expression?.type === 'Identifier' && dynamicRequireLoaders.has(expression.name);
      if (!dynamicRequireLoaders.has(name) && (aliasesLoader || createsRequireLoader(expression))) {
        dynamicRequireLoaders.add(name);
        loaderAdded = true;
      }
    }
  }

  walk(sourceFile, (node) => {
    const values =
      node.type === 'VariableDeclarator'
        ? staticStrings(node.init, bindings)
        : node.type === 'AssignmentExpression'
          ? staticStrings(node.right, bindings)
          : node.type === 'Property' || node.type === 'PropertyDefinition'
            ? staticStrings(node.value, bindings)
            : node.type === 'Literal' ||
                node.type === 'StringLiteral' ||
                node.type === 'TemplateElement' ||
                node.type === 'TemplateLiteral' ||
                node.type === 'BinaryExpression'
              ? staticStrings(node, bindings)
              : [];
    for (const value of values) {
      const hosts = providerHosts(value);
      for (const host of hosts) {
        const hostPolicy = hostPolicies.get(host);
        if (hostPolicy) {
          const allowedAsNonExecution = isAllowedNonExecutionHostLiteral(
            path,
            node,
            parents,
            hostPolicy.allowedNonExecutionHostPaths,
          );
          if (allowedAsNonExecution) nonExecutionHostsSeen.add(host);
          else findings.hosts.add(host);
        }
        if (
          path.startsWith('packages/provider-clients/') &&
          !hostPolicies.has(host) &&
          !nonProviderHostPolicies
            .get(host)
            ?.allowedExecutionPaths.some((pattern) => pathMatchesPolicy(path, pattern))
        ) {
          findings.unknownHosts.add(host);
        }
      }
    }
    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      staticStrings(node.source, bindings).some((source) => importPolicies.has(source))
    ) {
      for (const source of staticStrings(node.source, bindings)) {
        if (importPolicies.has(source)) findings.sdkPackages.add(source);
      }
    }
    if (node.type === 'ImportExpression') {
      const resolvedSources = staticStrings(node.source, bindings);
      const exactPackages = resolvedSources.filter((source) => importPolicies.has(source));
      if (exactPackages.length > 0) {
        exactPackages.forEach((packageName) => findings.sdkPackages.add(packageName));
      } else if (resolvedSources.length === 0) {
        findings.unresolvedDynamicLoads = true;
        for (const packageName of importPolicies.keys()) {
          if (syntaxContainsDependencyTaint(node.source, packageName)) {
            findings.sdkPackages.add(packageName);
          }
        }
      }
    }
    if (node.type === 'CallExpression') {
      const names = calleeNames(node.callee, bindings);
      const reflectApply = isReflectApply(node.callee, bindings);
      const callableMethodNames = memberPropertyNames(node.callee, bindings);
      const forwardsNetworkCallable = (node.arguments ?? []).some((argument) =>
        containsNetworkCallableValue(argument, bindings),
      );
      if (forwardsNetworkCallable) findings.unapprovedDynamicNetwork = true;
      const invokedExecutorNames = transportExecutorNames(
        reflectApply ? node.arguments?.[0] : node.callee,
        bindings,
        transportExecutorPolicies,
      );
      for (const name of invokedExecutorNames) {
        const executorPolicy = transportExecutorPolicies.get(name);
        if (!executorPolicy) continue;
        const invocationArguments = reflectApply
          ? node.arguments?.[2]?.type === 'ArrayExpression'
            ? node.arguments[2].elements
            : []
          : node.callee?.type === 'MemberExpression' && callableMethodNames.includes('apply')
            ? node.arguments?.[1]?.type === 'ArrayExpression'
              ? node.arguments[1].elements
              : []
            : node.callee?.type === 'MemberExpression' && callableMethodNames.includes('call')
              ? node.arguments.slice(1)
              : node.arguments;
        const requestTargets = executorRequestTargets(invocationArguments?.[0], bindings);
        const targetsApproved =
          requestTargets.length > 0 &&
          requestTargets.every((target) => {
            const targetStrings = staticNetworkArgumentStrings(target, bindings);
            const targetHosts = targetStrings.flatMap(providerHosts);
            const staticHostsApproved =
              targetHosts.length > 0 && targetHosts.every((host) => hostPolicies.has(host));
            const targetIssuer = targetAuthority(target, bindings, networkTargetAuthorities);
            const authorityApproved =
              targetIssuer !== undefined &&
              executorPolicy.allowedAuthorityIds.includes(targetIssuer.id);
            return (
              runtimeEnvironmentVariables(target, bindings).size === 0 &&
              (staticHostsApproved || authorityApproved)
            );
          });
        if (!executorPolicy.allowedCallPaths.includes(path) || !targetsApproved) {
          findings.unapprovedTransportExecutorUse = true;
        }
      }
      if (
        invokedExecutorNames.size === 0 &&
        node.arguments.some(
          (argument) =>
            transportExecutorNames(argument, bindings, transportExecutorPolicies).size > 0,
        )
      ) {
        findings.unapprovedTransportExecutorUse = true;
      }
      const functionApply =
        node.callee?.type === 'MemberExpression' &&
        callableMethodNames.includes('apply') &&
        isNetworkCallable(node.callee.object, bindings);
      const functionCall =
        node.callee?.type === 'MemberExpression' &&
        callableMethodNames.includes('call') &&
        isNetworkCallable(node.callee.object, bindings);
      const reflectLoaderApply =
        reflectApply &&
        isDynamicLoaderCallable(node.arguments?.[0], bindings, dynamicRequireLoaders);
      const loaderApply =
        node.callee?.type === 'MemberExpression' &&
        callableMethodNames.includes('apply') &&
        isDynamicLoaderCallable(node.callee.object, bindings, dynamicRequireLoaders);
      const loaderCall =
        node.callee?.type === 'MemberExpression' &&
        callableMethodNames.includes('call') &&
        isDynamicLoaderCallable(node.callee.object, bindings, dynamicRequireLoaders);
      const directReadMethod = callableMethodNames.some((name) =>
        ['get', 'head', 'options'].includes(name),
      );
      const receiverIsKnownNonNetwork =
        node.callee?.type === 'MemberExpression' &&
        ((node.callee.object?.type === 'Identifier' &&
          node.callee.object.name === 'Reflect' &&
          callableMethodNames.includes('get')) ||
          isKnownNonNetworkReadReceiver(
            node.callee.object,
            bindings,
            shadowedBuiltinCollections,
            knownCollectionFactories,
            new Set(),
            callableMethodNames,
          ));
      const callableIsNetwork = reflectApply
        ? isNetworkCallable(node.arguments?.[0], bindings)
        : isNetworkCallable(node.callee, bindings);
      const xhrOpen =
        node.callee?.type === 'MemberExpression' &&
        callableMethodNames.includes('open') &&
        bindingValues(bindings, node.callee.object).some(
          (candidate) =>
            candidate?.type === 'NewExpression' &&
            calleeNames(candidate.callee, bindings).includes('XMLHttpRequest'),
        );
      const localWrapperCall =
        node.callee?.type === 'Identifier' && localFunctionNames.has(node.callee.name);
      let localClassMethodCall = false;
      if (
        node.callee?.type === 'MemberExpression' &&
        node.callee.object?.type === 'ThisExpression'
      ) {
        const calledMethods = memberPropertyNames(node.callee, bindings);
        let owner = parents.get(node);
        while (owner && owner.type !== 'ClassDeclaration' && owner.type !== 'ClassExpression') {
          owner = parents.get(owner);
        }
        localClassMethodCall = (owner?.body?.body ?? []).some((element) => {
          if (element.type !== 'MethodDefinition') return false;
          const keys = element.computed
            ? staticStrings(element.key, bindings)
            : [element.key?.name ?? element.key?.value].filter(Boolean);
          return keys.some((key) => calledMethods.includes(key));
        });
      }
      const isNetworkExecution =
        (callableIsNetwork &&
          !receiverIsKnownNonNetwork &&
          !localWrapperCall &&
          !localClassMethodCall) ||
        (directReadMethod && !receiverIsKnownNonNetwork) ||
        xhrOpen;
      if (
        callableMethodNames.some((name) => networkMethodNames.has(name)) &&
        node.arguments?.[0]?.type !== 'Identifier'
      ) {
        for (const value of staticNetworkArgumentStrings(node.arguments?.[0], bindings)) {
          for (const host of providerHosts(value)) {
            if (
              !hostPolicies.has(host) &&
              !nonProviderHostPolicies
                .get(host)
                ?.allowedExecutionPaths.some((pattern) => pathMatchesPolicy(path, pattern))
            ) {
              findings.unknownHosts.add(host);
            }
          }
        }
      }
      const directDynamicLoader =
        !callableMethodNames.includes('bind') &&
        isDynamicLoaderCallable(node.callee, bindings, dynamicRequireLoaders);
      const isDynamicLoaderExecution =
        directDynamicLoader ||
        reflectLoaderApply ||
        loaderApply ||
        loaderCall ||
        names.some((name) => name === 'eval' || name === 'Function');
      if (names.some((name) => name === 'eval' || name === 'Function')) {
        findings.unresolvedDynamicLoads = true;
      }
      const dynamicLoaderArguments = reflectLoaderApply
        ? node.arguments?.[2]?.type === 'ArrayExpression'
          ? node.arguments[2].elements
          : []
        : loaderApply
          ? node.arguments?.[1]?.type === 'ArrayExpression'
            ? node.arguments[1].elements
            : []
          : loaderCall
            ? node.arguments.slice(1)
            : (node.arguments ?? []);
      if (isNetworkExecution) {
        for (const host of nonExecutionHostsSeen) findings.hosts.add(host);
      }
      for (const packageName of importPolicies.keys()) {
        if (
          staticStrings(dynamicLoaderArguments[0], bindings).includes(packageName) &&
          isDynamicLoaderExecution
        ) {
          findings.sdkPackages.add(packageName);
        }
        if (
          isDynamicLoaderExecution &&
          syntaxContainsDependencyTaint({ type: 'Arguments', values: node.arguments }, packageName)
        ) {
          findings.sdkPackages.add(packageName);
        }
      }
      if (
        isDynamicLoaderExecution &&
        !names.some((name) => name === 'eval' || name === 'Function') &&
        staticStrings(dynamicLoaderArguments[0], bindings).length === 0
      ) {
        findings.unresolvedDynamicLoads = true;
      }
      if (isNetworkExecution) {
        const networkArguments = xhrOpen
          ? node.arguments.slice(1)
          : reflectApply && node.arguments?.[2]?.type === 'ArrayExpression'
            ? node.arguments[2].elements
            : functionApply && node.arguments?.[1]?.type === 'ArrayExpression'
              ? node.arguments[1].elements
              : functionCall
                ? node.arguments.slice(1)
                : (node.arguments ?? []);
        for (const argument of networkArguments) {
          for (const value of staticNetworkArgumentStrings(argument, bindings)) {
            for (const host of providerHosts(value)) {
              if (
                !hostPolicies.has(host) &&
                !nonProviderHostPolicies
                  .get(host)
                  ?.allowedExecutionPaths.some((pattern) => pathMatchesPolicy(path, pattern))
              ) {
                findings.unknownHosts.add(host);
              }
            }
          }
        }
        const receiverConstructorTarget =
          node.callee?.type === 'MemberExpression'
            ? bindingValues(bindings, node.callee.object).find(
                (candidate) => candidate?.type === 'NewExpression' && candidate.arguments?.[0],
              )?.arguments?.[0]
            : undefined;
        const receiverConstructor =
          node.callee?.type === 'MemberExpression'
            ? bindingValues(bindings, node.callee.object).find(
                (candidate) => candidate?.type === 'NewExpression',
              )
            : undefined;
        const targetArgument = receiverConstructorTarget ?? networkArguments[0];
        const targetStrings = staticNetworkArgumentStrings(targetArgument, bindings);
        for (const variable of runtimeEnvironmentVariables(targetArgument, bindings)) {
          findings.dynamicNetworkEnvironmentVariables.add(variable);
        }
        const configuredTargetKind = configuredNetworkTargetKind(targetArgument, bindings);
        if (configuredTargetKind) findings.dynamicNetworkTargetKinds.add(configuredTargetKind);
        for (const source of networkTargetSources(targetArgument, bindings)) {
          findings.dynamicNetworkTargetSources.add(source);
        }
        const hasResolvedHost = targetStrings.some((value) => providerHosts(value).length > 0);
        const isStaticallyRelative =
          isSyntacticallyRelativeTarget(targetArgument, bindings) ||
          (targetStrings.length > 0 &&
            targetStrings.every(
              (value) =>
                value.startsWith('/') ||
                value.startsWith('./') ||
                value.startsWith('../') ||
                value.startsWith('?') ||
                value.startsWith('#'),
            ));
        if (
          isNetworkExecution &&
          !hasResolvedHost &&
          !isStaticallyRelative &&
          (targetStrings.length === 0 || containsRuntimeConfiguredTarget(targetArgument, bindings))
        ) {
          for (const target of targetAlternatives(targetArgument)) {
            const enclosingExport = containingExportedFunction(node, parents);
            const enclosingAuthority = enclosingExport
              ? authorityForIdentity(networkTargetAuthorities, {
                  type: 'workspace-export',
                  path,
                  export: enclosingExport,
                })
              : undefined;
            const receiverAuthority = receiverConstructor
              ? authorityForIdentity(
                  networkTargetAuthorities,
                  bindings.resolveSymbolIdentity(receiverConstructor.callee),
                )
              : undefined;
            const issuedAuthority =
              targetAuthority(target, bindings, networkTargetAuthorities) ??
              targetAuthority(node.callee, bindings, networkTargetAuthorities);
            const authority = receiverAuthority ?? issuedAuthority ?? enclosingAuthority;
            findings.dynamicNetworkTargets.push({
              authorityId: authority?.id,
              environmentVariables: [...runtimeEnvironmentVariables(target, bindings)],
              kind: authority?.kind,
              method: networkExecutionMethod(node, bindings),
              outputShape: authority?.outputShape,
            });
          }
          const executor = containingExportedFunction(node, parents);
          if (!executor || !transportExecutors.get(path)?.has(executor)) {
            findings.unapprovedDynamicNetwork = true;
          }
        }
        const executesProviderHost = targetStrings.some((value) =>
          providerHosts(value).some((host) => hostPolicies.has(host)),
        );
        if (executesProviderHost) {
          const executor = containingExportedFunction(node, parents);
          if (!executor || !transportExecutors.get(path)?.has(executor)) {
            findings.unapprovedProviderNetwork = true;
          }
        }
      }
    }
    if (node.type === 'TSImportEqualsDeclaration') {
      for (const source of staticStrings(node.moduleReference?.expression, bindings)) {
        if (importPolicies.has(source)) findings.sdkPackages.add(source);
      }
    }
    if (node.type === 'NewExpression') {
      const browserStreamConstructor = calleeNames(node.callee, bindings).find((name) =>
        ['EventSource', 'WebSocket'].includes(name),
      );
      if (browserStreamConstructor) {
        const target = node.arguments?.[0];
        const targetStrings = staticNetworkArgumentStrings(target, bindings);
        const hosts = targetStrings.flatMap(providerHosts);
        for (const host of hosts) {
          const policy = hostPolicies.get(host);
          if (policy) findings.unapprovedProviderNetwork = true;
          else if (
            !nonProviderHostPolicies
              .get(host)
              ?.allowedExecutionPaths.some((pattern) => pathMatchesPolicy(path, pattern))
          ) {
            findings.unknownHosts.add(host);
          }
        }
        if (hosts.length === 0 || containsRuntimeConfiguredTarget(target, bindings)) {
          const authority = targetAuthority(target, bindings, networkTargetAuthorities);
          findings.dynamicNetworkTargets.push({
            authorityId: authority?.id,
            environmentVariables: [...runtimeEnvironmentVariables(target, bindings)],
            kind: authority?.kind,
            method: 'GET',
            outputShape: authority?.outputShape,
          });
          findings.unapprovedDynamicNetwork = true;
        }
      }
      if (calleeNames(node.callee, bindings).some((name) => name === 'Function')) {
        findings.unresolvedDynamicLoads = true;
        for (const packageName of importPolicies.keys()) {
          if (
            syntaxContainsDependencyTaint(
              { type: 'Arguments', values: node.arguments },
              packageName,
            )
          ) {
            findings.sdkPackages.add(packageName);
          }
        }
      }
      if (node.callee?.type === 'Identifier' && node.callee.name === 'Stripe') {
        findings.sdkPackages.add('stripe');
      }
    }
  });
  return {
    hosts: [...findings.hosts],
    sdkPackages: [...findings.sdkPackages],
    unknownHosts: [...findings.unknownHosts],
    unresolvedDynamicLoads: findings.unresolvedDynamicLoads,
    unapprovedDynamicNetwork: findings.unapprovedDynamicNetwork,
    unapprovedProviderNetwork: findings.unapprovedProviderNetwork,
    dynamicNetworkEnvironmentVariables: [...findings.dynamicNetworkEnvironmentVariables],
    dynamicNetworkTargetKinds: [...findings.dynamicNetworkTargetKinds],
    dynamicNetworkTargetSources: [...findings.dynamicNetworkTargetSources],
    dynamicNetworkTargets: findings.dynamicNetworkTargets,
    unapprovedTransportExecutorUse: findings.unapprovedTransportExecutorUse,
  };
}

export function providerClientBoundaryViolations(
  root,
  { sourceRoots = ['apps', 'packages'], registry = loadProviderIntegrationRegistry(root) } = {},
) {
  const repositoryRoot = resolve(root);
  const hostPolicies = registryHostPolicies(registry);
  const importPolicies = registryImportPolicies(registry);
  const nonProviderHostPolicies = registryNonProviderHostPolicies(registry);
  const transportExecutors = registryTransportExecutors(registry);
  const transportExecutorPolicies = registryTransportExecutorPolicies(registry);
  const networkTargetAuthorities = registryNetworkTargetAuthorities(registry);
  const nonNetworkReceiverTypes = registryNonNetworkReceiverTypes(registry);
  const violations = [];
  const sourceEntries = [];
  for (const sourceRoot of sourceRoots) {
    const absoluteRoot = resolve(repositoryRoot, sourceRoot);
    let files;
    try {
      files = walk(absoluteRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const absolutePath of files) {
      const path = normalizedRelative(repositoryRoot, absolutePath);
      if (!isRuntimeSource(path)) continue;
      const source = readFileSync(absolutePath, 'utf8');
      sourceEntries.push({ path, source });
    }
  }
  const availableWorkspaceModulePaths = new Set(sourceEntries.map(({ path }) => path));
  const sourceSha256ByPath = new Map(
    sourceEntries.map(({ path, source }) => [path, sourceSha256(source)]),
  );
  networkTargetAuthorities.trustedWorkspaceIssuerIdentities = new Set(
    registry.networkTargetAuthorities
      .filter(
        ({ issuer }) =>
          issuer.type === 'workspace-export' &&
          sourceSha256ByPath.get(issuer.path) === issuer.sha256,
      )
      .map(({ issuer }) => symbolIdentityKey(issuer)),
  );
  const safeCollectionFactoryIdentities = new Set(
    sourceEntries.flatMap(({ path, source }) =>
      exportedCollectionFactoryIdentityKeys(path, source),
    ),
  );
  for (const { path, source } of sourceEntries) {
    const findings = {
      hosts: [],
      sdkPackages: [],
      unknownHosts: [],
      unresolvedDynamicLoads: false,
      unapprovedDynamicNetwork: false,
      unapprovedProviderNetwork: false,
      dynamicNetworkEnvironmentVariables: [],
      dynamicNetworkTargetKinds: [],
      dynamicNetworkTargetSources: [],
      dynamicNetworkTargets: [],
      unapprovedTransportExecutorUse: false,
    };
    for (const componentSource of executableComponentSources(path, source)) {
      const unitFindings = providerSourceBoundaryFindings(
        componentSource.path,
        componentSource.source,
        hostPolicies,
        importPolicies,
        nonProviderHostPolicies,
        transportExecutors,
        transportExecutorPolicies,
        networkTargetAuthorities,
        safeCollectionFactoryIdentities,
        nonNetworkReceiverTypes,
        availableWorkspaceModulePaths,
      );
      findings.hosts.push(...unitFindings.hosts);
      findings.sdkPackages.push(...unitFindings.sdkPackages);
      findings.unknownHosts.push(...unitFindings.unknownHosts);
      findings.unresolvedDynamicLoads ||= unitFindings.unresolvedDynamicLoads;
      findings.unapprovedDynamicNetwork ||= unitFindings.unapprovedDynamicNetwork;
      findings.unapprovedProviderNetwork ||= unitFindings.unapprovedProviderNetwork;
      findings.dynamicNetworkEnvironmentVariables.push(
        ...unitFindings.dynamicNetworkEnvironmentVariables,
      );
      findings.dynamicNetworkTargetKinds.push(...unitFindings.dynamicNetworkTargetKinds);
      findings.dynamicNetworkTargetSources.push(...unitFindings.dynamicNetworkTargetSources);
      findings.dynamicNetworkTargets.push(...unitFindings.dynamicNetworkTargets);
      findings.unapprovedTransportExecutorUse ||= unitFindings.unapprovedTransportExecutorUse;
    }
    for (const packageName of findings.sdkPackages) {
      const policy = importPolicies.get(packageName);
      if (!policy?.paths.some((pattern) => pathMatchesPolicy(path, pattern))) {
        violations.push(
          packageName === 'stripe' || packageName === '@stripe/stripe-js'
            ? `${path}: server-side Stripe SDK execution must cross @tixkit/provider-clients`
            : `${path}: ${packageName} execution is outside its provider-registry boundary`,
        );
      }
    }
    let pathHasHostViolation = false;
    for (const host of findings.hosts) {
      const policy = hostPolicies.get(host);
      if (!policy?.allowedHostPaths.some((pattern) => pathMatchesPolicy(path, pattern))) {
        pathHasHostViolation = true;
        const integration = registry.integrations.find(({ id }) => id === policy?.integrationId);
        violations.push(
          integration?.id === 'stripe-server-gateway'
            ? `${path}: server-side Stripe REST execution must cross @tixkit/provider-clients`
            : integration?.classification === 'direct-http'
              ? `${path}: migrated messaging provider endpoints must be owned by @tixkit/provider-clients`
              : `${path}: ${host} execution must cross its registry owner (${policy?.integrationId})`,
        );
      }
    }
    for (const host of findings.unknownHosts) {
      pathHasHostViolation = true;
      violations.push(`${path}: outbound host is not classified in the provider registry: ${host}`);
    }
    if (findings.unapprovedProviderNetwork && !pathHasHostViolation) {
      violations.push(
        `${path}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
      );
    }
    const dynamicTargetsAllowed =
      findings.dynamicNetworkTargets.length > 0 &&
      findings.dynamicNetworkTargets.every((target) =>
        registryAllowsDynamicNetworkTarget(registry, path, target),
      );
    if (findings.unapprovedDynamicNetwork && !pathHasHostViolation && !dynamicTargetsAllowed) {
      violations.push(
        `${path}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
      );
    }
    if (findings.unresolvedDynamicLoads) {
      violations.push(`${path}: unresolved dynamic module loading is prohibited`);
    }
    if (findings.unapprovedTransportExecutorUse) {
      violations.push(
        `${path}: provider transport executor use is outside its exact typed-operation boundary`,
      );
    }
  }
  return [...new Set(violations)].sort();
}
