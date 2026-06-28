type CjsModule = Record<string, unknown>;

async function patchModule(cjsName: string, esmName: string, sentinel: string): Promise<void> {
  let cjs: CjsModule;
  try {
    cjs = require(cjsName) as CjsModule;
  } catch {
    return;
  }
  if (cjs[sentinel]) return;

  let esm: CjsModule;
  try {
    esm = (await import(esmName)) as CjsModule;
  } catch {
    return;
  }

  for (const key of Object.keys(esm)) {
    if (cjs[key] === undefined) {
      try {
        cjs[key] = esm[key];
      } catch {
        // Skip read-only properties
      }
    }
  }
}

await Promise.all([
  patchModule('@opentelemetry/core', '@opentelemetry/core', 'TracesSamplerValues'),
  patchModule(
    '@opentelemetry/sdk-trace-base',
    '@opentelemetry/sdk-trace-base',
    'BasicTracerProvider',
  ),
]);
