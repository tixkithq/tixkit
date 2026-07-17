import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseSync } from 'oxc-parser';
import {
  loadProviderIntegrationRegistry,
  pathMatchesPolicy,
  registryHostPolicies,
  registryImportPolicies,
  registryNonProviderHostPolicies,
} from './provider-integration-registry.mjs';

const sourceExtension = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const ignoredSegment =
  /(?:^|\/)(?:\.dart_tool|\.expo|\.next|\.output|\.turbo|__tests__|build|coverage|dist|fixtures|generated|node_modules|out|test-results)(?:\/|$)/u;
const testFile = /(?:^|\/)[^/]+\.(?:integration\.)?(?:spec|test)\.[^.]+$/u;
const networkMethodNames = new Set(['delete', 'fetch', 'get', 'patch', 'post', 'put', 'request']);

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      [
        '.dart_tool',
        '.expo',
        '.next',
        '.output',
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

function staticStrings(node, bindings, seen = new Set()) {
  if (!node) return [];
  if (node.type === 'Literal' && typeof node.value === 'string') return [node.value];
  if (node.type === 'StringLiteral') return [node.value];
  if (node.type === 'TemplateElement') return [node.value?.cooked ?? node.value?.raw ?? ''];
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
    const initializers = bindings.get(node.name) ?? [];
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
    return staticStrings(node.arguments?.[0], bindings, seen);
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
  if (node.type !== 'Identifier') return [node];
  if (seen.has(node.name)) return [];
  const nextSeen = new Set([...seen, node.name]);
  return (bindings.get(node.name) ?? []).flatMap((initializer) =>
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
      ...(bindings.get(expression.name) ?? []).flatMap((value) =>
        calleeNames(value, bindings, nextSeen),
      ),
    ];
  }
  if (expression.type === 'MemberExpression') {
    return expression.computed
      ? staticStrings(expression.property, bindings)
      : [expression.property?.name].filter(Boolean);
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
  if (expression.type === 'Identifier') {
    if (networkMethodNames.has(expression.name)) return true;
    return (bindings.get(expression.name) ?? []).some((initializer) =>
      isNetworkCallable(initializer, bindings, nextSeen),
    );
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
    return containsNetworkInvocation(expression.body, bindings, nextSeen);
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
  if (propertyNames.some((name) => networkMethodNames.has(name))) return true;
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
  for (const match of value.matchAll(/https?:\/\/[A-Za-z0-9.-]+/giu)) {
    try {
      hosts.push(new URL(match[0]).hostname.toLowerCase());
    } catch {
      // A malformed literal is not an executable provider endpoint.
    }
  }
  return hosts;
}

function sourceMayContainProviderBoundary(source, hostPolicies, importPolicies) {
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
    /(?:\bfetch\b|\brequire\b|\bimport\s*\(|\.(?:delete|fetch|get|patch|post|put|request)\s*\()/u.test(
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
) {
  if (!sourceMayContainProviderBoundary(source, hostPolicies, importPolicies)) {
    return {
      hosts: [],
      sdkPackages: [],
      unknownHosts: [],
    };
  }
  const parsed = parseSync(path, source, { preserveParens: true });
  if (parsed.errors.length > 0) {
    throw new Error(`Unable to parse ${path} while validating provider boundaries`);
  }
  const sourceFile = parsed.program;
  const bindings = new Map();
  const parents = new WeakMap();
  const findings = {
    hosts: new Set(),
    sdkPackages: new Set(),
    unknownHosts: new Set(),
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
  const bind = (name, value) => {
    const values = bindings.get(name) ?? [];
    values.push(value);
    bindings.set(name, values);
  };
  const createRequireFactories = new Set(['createRequire']);
  const moduleNamespaces = new Set();
  const dynamicRequireLoaders = new Set(['require']);
  walk(sourceFile, (node) => {
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
          bind(property.value.name, property.key);
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
      const functionApply =
        node.callee?.type === 'MemberExpression' &&
        callableMethodNames.includes('apply') &&
        isNetworkCallable(node.callee.object, bindings);
      const functionCall =
        node.callee?.type === 'MemberExpression' &&
        callableMethodNames.includes('call') &&
        isNetworkCallable(node.callee.object, bindings);
      const isNetworkExecution = reflectApply
        ? isNetworkCallable(node.arguments?.[0], bindings)
        : isNetworkCallable(node.callee, bindings);
      const isDynamicLoaderExecution = names.some(
        (name) => name === 'eval' || name === 'Function' || dynamicRequireLoaders.has(name),
      );
      if (isNetworkExecution) {
        for (const host of nonExecutionHostsSeen) findings.hosts.add(host);
      }
      for (const packageName of importPolicies.keys()) {
        if (
          staticStrings(node.arguments?.[0], bindings).includes(packageName) &&
          names.some((name) => dynamicRequireLoaders.has(name))
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
      if (isNetworkExecution) {
        const networkArguments =
          reflectApply && node.arguments?.[2]?.type === 'ArrayExpression'
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
      }
    }
    if (node.type === 'TSImportEqualsDeclaration') {
      for (const source of staticStrings(node.moduleReference?.expression, bindings)) {
        if (importPolicies.has(source)) findings.sdkPackages.add(source);
      }
    }
    if (node.type === 'NewExpression') {
      if (calleeNames(node.callee, bindings).some((name) => name === 'Function')) {
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
  const violations = [];
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
      const findings = providerSourceBoundaryFindings(
        path,
        source,
        hostPolicies,
        importPolicies,
        nonProviderHostPolicies,
      );
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
      for (const host of findings.hosts) {
        const policy = hostPolicies.get(host);
        if (!policy?.allowedHostPaths.some((pattern) => pathMatchesPolicy(path, pattern))) {
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
        violations.push(
          `${path}: outbound host is not classified in the provider registry: ${host}`,
        );
      }
    }
  }
  return violations.sort();
}
