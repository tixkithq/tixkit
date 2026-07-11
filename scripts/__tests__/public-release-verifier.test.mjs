import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const verifier = resolve(root, "scripts/verify-public-api-release.mjs");
const immutableFixtureRoot = mkdtempSync(
  resolve(tmpdir(), "tixkit-verifier-contracts-"),
);
const contracts = resolve(immutableFixtureRoot, "2026-01-01");
cpSync(resolve(root, "artifacts/api/2026-01-01"), contracts, {
  recursive: true,
});

function runVerifier(mode) {
  const fixture = mkdtempSync(resolve(tmpdir(), "tixkit-verifier-test-"));
  const bin = resolve(fixture, "bin");
  mkdirSync(bin);
  const preload = resolve(fixture, "preload.mjs");
  writeFileSync(
    preload,
    `import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
globalThis.fetch = async (url) => {
  const name = basename(new URL(url).pathname);
  if (process.env.VERIFIER_MODE === 'missing' && name === 'openapi.json') return new Response('', { status: 404 });
  let bytes = await readFile(join(process.env.VERIFIER_CONTRACTS, name));
  if (process.env.VERIFIER_MODE === 'trusted-mismatch' && name === 'CHECKSUMS.sha256') bytes = Buffer.concat([bytes, Buffer.from('\\n')]);
  return new Response(bytes, { status: 200 });
};
`,
  );
  const gh = resolve(bin, "gh");
  writeFileSync(
    gh,
    '#!/bin/sh\n[ "$VERIFIER_MODE" = "attestation" ] && exit 17\nexit 0\n',
  );
  chmodSync(gh, 0o755);
  const npm = resolve(bin, "npm");
  writeFileSync(
    npm,
    `#!/bin/sh
case "$1" in
  view)
    case "$2" in
      @tixkit/js@*) name='@tixkit/js' ;;
      *) name='@tixkit/contract-tests' ;;
    esac
    version="\${2##*@}"
    printf '{"name":"%s","version":"%s","dist.integrity":"sha512-good"}\\n' "$name" "$version"
    ;;
  pack)
    spec="$2"
    shift 2
    while [ "$1" != '' ]; do
      if [ "$1" = '--pack-destination' ]; then destination="$2"; break; fi
      shift
    done
    case "$spec" in
      @tixkit/js@*) filename='tixkit-js.tgz' ;;
      *) filename='tixkit-contract-tests.tgz' ;;
    esac
    : > "$destination/$filename"
    integrity='sha512-good'
    [ "$VERIFIER_MODE" = 'registry-integrity' ] && integrity='sha512-wrong'
    printf '[{"filename":"%s","integrity":"%s"}]\\n' "$filename" "$integrity"
    ;;
  install) exit 0 ;;
  audit) [ "$VERIFIER_MODE" = 'signature' ] && exit 23; exit 0 ;;
esac
`,
  );
  chmodSync(npm, 0o755);
  const node = resolve(bin, "node");
  writeFileSync(
    node,
    '#!/bin/sh\n[ "$VERIFIER_MODE" = "consumer" ] && exit 29\nexit 0\n',
  );
  chmodSync(node, 0o755);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      verifier,
      "--contracts-url",
      "https://contracts.example.test/2026-01-01/",
      "--sdk-spec",
      "@tixkit/js@1.2.3",
      "--contract-tests-spec",
      "@tixkit/contract-tests@1.2.3",
      "--trusted-contracts-root",
      immutableFixtureRoot,
      "--repository",
      "tixkit/tixkit",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        VERIFIER_CONTRACTS: contracts,
        VERIFIER_MODE: mode,
      },
    },
  );
  rmSync(fixture, { recursive: true, force: true });
  return result;
}

test("fails when a public trust root file differs from the protected tag", () => {
  const result = runVerifier("trusted-mismatch");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the protected tag/u);
});

test("fails when a manifest artifact is absent", () => {
  const result = runVerifier("missing");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unable to download openapi\.json: HTTP 404/u);
});

test("fails when provenance attestation verification fails", () => {
  const result = runVerifier("attestation");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Command failed/u);
});

test("fails when registry pack integrity differs from registry metadata", () => {
  const result = runVerifier("registry-integrity");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /integrity does not match/u);
});

test("fails when npm registry signature verification fails", () => {
  const result = runVerifier("signature");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Command failed/u);
});

test("fails when the packed SDK consumer contract process detects a mismatch", () => {
  const result = runVerifier("consumer");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Command failed/u);
});
