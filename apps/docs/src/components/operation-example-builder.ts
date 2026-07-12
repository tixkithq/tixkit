type Parameter = {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const identifier = (name: string) => {
  const value = name
    .replace(/[^a-zA-Z0-9]+(.)/gu, (_, character: string) => character.toUpperCase())
    .replace(/^[^a-zA-Z_$]/u, '_$&');
  return value ? value[0]!.toLowerCase() + value.slice(1) : 'value';
};
const shellVariable = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/gu, '_')
    .toUpperCase();

const providerSignatures: Record<string, readonly string[]> = {
  StripeSignature: ['Stripe-Signature'],
  SvixSignature: ['svix-id', 'svix-timestamp', 'svix-signature'],
  TelnyxSignature: ['telnyx-timestamp', 'telnyx-signature-ed25519'],
  EmailProviderSignature: ['x-tixkit-provider-signature'],
};

function securityProfile(security: readonly Record<string, readonly string[]>[]) {
  const schemes = Object.keys(security[0] ?? {});
  const provider = schemes.find((scheme) => providerSignatures[scheme]);
  if (provider) {
    return {
      receiverOnly: true,
      curlHeaders: providerSignatures[provider]!.map(
        (header) => `--header "${header}: $${shellVariable(header)}"`,
      ),
      client: 'providerCallbackReceiver',
    };
  }
  const curlHeaders = schemes.flatMap((scheme) => {
    if (scheme.toLowerCase() === 'bearerauth') {
      return ['--header "Authorization: Bearer $TIXKIT_ACCESS_TOKEN"'];
    }
    if (scheme === 'ApiKey') {
      return ['--header "Authorization: Bearer $TIXKIT_API_KEY"'];
    }
    if (scheme === 'ScannerDeviceAuth') {
      return [
        '--header "X-Device-Id: $TIXKIT_DEVICE_ID"',
        '--header "X-Device-Secret: $TIXKIT_DEVICE_SECRET"',
      ];
    }
    return [`# Configure credential for declared security scheme: ${scheme}`];
  });
  return {
    receiverOnly: false,
    curlHeaders,
    client: schemes.length ? 'client' : 'anonymousClient',
  };
}

export function buildOperationExamples(input: {
  method: string;
  path: string;
  operationId: string;
  version: string;
  parameters: readonly unknown[];
  requestBody: unknown;
  security: readonly Record<string, readonly string[]>[];
}) {
  const parameters: Parameter[] = input.parameters.flatMap((value) =>
    record(value) &&
    typeof value.name === 'string' &&
    ['path', 'query', 'header'].includes(String(value.in))
      ? [
          {
            name: value.name,
            in: value.in as Parameter['in'],
            required: value.required === true,
          },
        ]
      : [],
  );
  const paths = parameters.filter((value) => value.in === 'path');
  const queries = parameters.filter((value) => value.in === 'query');
  const headers = parameters.filter((value) => value.in === 'header');
  const idempotency = headers.find((value) => value.name.toLowerCase() === 'idempotency-key');
  const ordinaryHeaders = headers.filter((value) => value !== idempotency);
  const hasBody = input.requestBody !== null && input.requestBody !== undefined;
  const security = securityProfile(input.security);
  const curlPath = paths.reduce(
    (value, parameter) => value.replace(`{${parameter.name}}`, `$${shellVariable(parameter.name)}`),
    input.path,
  );
  const curlQuery = queries.map(
    (parameter) =>
      `--url-query "${encodeURIComponent(parameter.name)}=$${shellVariable(parameter.name)}"`,
  );
  const curl = [
    ...(security.receiverOnly
      ? ['# Receiver example only: verify the provider signature against the raw request body.']
      : []),
    `curl --request ${input.method} "$TIXKIT_API_URL/v1${curlPath}"`,
    ...curlQuery,
    ...security.curlHeaders,
    `--header "X-Tixkit-Version: ${input.version}"`,
    ...ordinaryHeaders.map((value) => `--header "${value.name}: $${shellVariable(value.name)}"`),
    ...(idempotency ? [`--header "${idempotency.name}: $IDEMPOTENCY_KEY"`] : []),
    ...(hasBody ? ['--header "Content-Type: application/json"', '--data @request.json'] : []),
  ].join(' \\\n  ');
  const jsPath = paths.reduce(
    (value, parameter) =>
      value.replace(
        `{${parameter.name}}`,
        `\${encodeURIComponent(String(${identifier(parameter.name)}))}`,
      ),
    input.path,
  );
  const querySetup = queries.length
    ? `const query = new URLSearchParams({ ${queries.map((value) => `${JSON.stringify(value.name)}: String(${identifier(value.name)})`).join(', ')} });\n`
    : '';
  const options = [
    ...(ordinaryHeaders.length
      ? [
          `headers: { ${ordinaryHeaders.map((value) => `${JSON.stringify(value.name)}: String(${identifier(value.name)})`).join(', ')} }`,
        ]
      : []),
    ...(idempotency
      ? [`idempotencyKey: ${idempotency.required ? 'idempotencyKey' : 'crypto.randomUUID()'}`]
      : []),
    ...(hasBody ? ['body: requestBody'] : []),
  ];
  const request = security.receiverOnly
    ? `// Receiver example only: verify the provider signature against the raw request body.\nawait ${security.client}.verify(request);`
    : `const path = \`${jsPath}${queries.length ? '?${query}' : ''}\`;\nconst response = await ${security.client}.request('${input.method}', path${options.length ? `, { ${options.join(', ')} }` : ''});`;
  return {
    curl,
    javascript: querySetup + request,
    typescript: `// Operation: ${input.operationId}\n${querySetup}${request}`,
  };
}
