import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseSync } from 'oxc-parser';

const sourceExtension = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const ignoredSegment =
  /(?:^|\/)(?:\.dart_tool|\.expo|\.next|\.output|\.turbo|__tests__|build|coverage|dist|fixtures|generated|node_modules|out|test-results)(?:\/|$)/u;
const testFile = /(?:^|\/)[^/]+\.(?:integration\.)?(?:spec|test)\.[^.]+$/u;
const migratedProviderHosts = new Set([
  'api.resend.com',
  'api.telnyx.com',
  'api.twilio.com',
  'rest.nexmo.com',
  'api.vonage.com',
  'api.plivo.com',
]);
const providerBoundaryAnchor =
  /(?:stripe|resend|telnyx|twilio|vonage|plivo|nexmo|['"]str['"]\s*\+\s*['"]ipe['"])/iu;
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

function stripeSdkAllowed(path) {
  return (
    path.startsWith('packages/provider-clients/') ||
    path === 'packages/api/src/routes/modules/stripe-webhooks.ts'
  );
}

function migratedEndpointAllowed(path) {
  return path.startsWith('packages/provider-clients/');
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
    node.type === 'MemberExpression' &&
    ((!node.computed && node.property?.name === 'href') ||
      (node.computed && staticStrings(node.property, bindings, seen).includes('href')))
  ) {
    return staticStrings(node.object, bindings, seen);
  }
  return [];
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

function sourceMayContainProviderBoundary(source) {
  const decoded = source
    .replace(/\\x([0-9a-f]{2})/giu, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/giu, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (_match, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
  const compact = decoded.replace(/[\s'"`+\\]/gu, '').toLowerCase();
  return (
    providerBoundaryAnchor.test(decoded) ||
    [...migratedProviderHosts, 'api.stripe.com'].some((host) => compact.includes(host)) ||
    compact.includes('stripe') ||
    /(?:\bfetch\b|\brequire\b|\bimport\s*\(|\.request\s*\()/u.test(decoded) ||
    ((decoded.includes('fromCharCode') || decoded.includes('fromCodePoint')) &&
      /(?:fetch|import|require|request)/u.test(decoded))
  );
}

function isAllowedCheckoutCspLiteral(path, node, parents) {
  if (path !== 'apps/checkout/src/lib/checkout-security-headers.ts') return false;
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
      current.type === 'FunctionDeclaration' &&
      current.id?.name === 'checkoutContentSecurityPolicy'
    ) {
      return returned;
    }
    if (
      current.type === 'FunctionDeclaration' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      return false;
    }
  }
  return false;
}

function sourceBoundaryFindings(path, source) {
  if (!sourceMayContainProviderBoundary(source)) {
    return { migratedEndpoint: false, stripeEndpoint: false, stripeSdk: false };
  }
  const parsed = parseSync(path, source, { preserveParens: true });
  if (parsed.errors.length > 0) {
    throw new Error(`Unable to parse ${path} while validating provider boundaries`);
  }
  const sourceFile = parsed.program;
  const bindings = new Map();
  const parents = new WeakMap();
  const findings = { migratedEndpoint: false, stripeEndpoint: false, stripeSdk: false };

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
  walk(sourceFile, (node) => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
      bind(node.id.name, node.init);
    }
    if (
      node.type === 'AssignmentExpression' &&
      node.operator === '=' &&
      node.left?.type === 'Identifier'
    ) {
      bind(node.left.name, node.right);
    }
  });

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
      if (hosts.includes('api.stripe.com') && !isAllowedCheckoutCspLiteral(path, node, parents)) {
        findings.stripeEndpoint = true;
      }
      if (hosts.some((host) => migratedProviderHosts.has(host))) {
        findings.migratedEndpoint = true;
      }
    }
    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      staticStrings(node.source, bindings).includes('stripe')
    ) {
      findings.stripeSdk = true;
    }
    if (
      node.type === 'ImportExpression' &&
      staticStrings(node.source, bindings).includes('stripe')
    ) {
      findings.stripeSdk = true;
    }
    if (node.type === 'CallExpression') {
      const names = calleeNames(node.callee, bindings);
      if (
        names.includes('require') &&
        staticStrings(node.arguments[0], bindings).includes('stripe')
      ) {
        findings.stripeSdk = true;
      }
      if (
        path === 'apps/checkout/src/lib/checkout-security-headers.ts' &&
        names.some((name) => networkMethodNames.has(name))
      ) {
        findings.stripeEndpoint = true;
      }
    }
    if (
      node.type === 'TSImportEqualsDeclaration' &&
      staticStrings(node.moduleReference?.expression, bindings).includes('stripe')
    )
      findings.stripeSdk = true;
    if (
      node.type === 'NewExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'Stripe'
    ) {
      findings.stripeSdk = true;
    }
  });
  return findings;
}

export function providerClientBoundaryViolations(
  root,
  { sourceRoots = ['apps', 'packages'] } = {},
) {
  const repositoryRoot = resolve(root);
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
      const findings = sourceBoundaryFindings(path, source);
      if (!stripeSdkAllowed(path) && findings.stripeSdk) {
        violations.push(
          `${path}: server-side Stripe SDK execution must cross @tixkit/provider-clients`,
        );
      }
      if (!migratedEndpointAllowed(path) && findings.migratedEndpoint) {
        violations.push(
          `${path}: migrated messaging provider endpoints must be owned by @tixkit/provider-clients`,
        );
      }
      if (!migratedEndpointAllowed(path) && findings.stripeEndpoint) {
        violations.push(
          `${path}: server-side Stripe REST execution must cross @tixkit/provider-clients`,
        );
      }
    }
  }
  return violations.sort();
}
