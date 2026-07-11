import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import {
  generateOpenApiTypes,
  openApiSpec,
} from "../packages/openapi/src/index.js";
import { WEBHOOK_EVENT_CATALOG } from "../packages/domain/src/developer/index.js";
import { compareOpenApi } from "./lib/openapi-compatibility.js";
import { assertPublicArtifactSafe } from "./lib/public-artifact-safety.js";

type JsonObject = Record<string, unknown>;

const root = resolve(import.meta.dirname, "..");
const version = openApiSpec.info.version;
const releaseRoot = resolve(root, "artifacts/api");
const output = join(releaseRoot, version);
const headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const headTimestamp = execFileSync(
  "git",
  ["show", "-s", "--format=%cI", "HEAD"],
  {
    cwd: root,
    encoding: "utf8",
  },
).trim();

const canonical = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

async function previousSpec(): Promise<
  { version: string; spec: JsonObject } | undefined
> {
  try {
    return {
      version,
      spec: JSON.parse(await readFile(join(output, "openapi.json"), "utf8")),
    };
  } catch {
    // Fall back to the immediately previous complete version for a first release of this version.
  }
  try {
    const versions = (await readdir(releaseRoot))
      .filter(
        (candidate) =>
          candidate !== version && /^\d{4}-\d{2}-\d{2}$/u.test(candidate),
      )
      .sort()
      .reverse();
    for (const candidate of versions) {
      try {
        return {
          version: candidate,
          spec: JSON.parse(
            await readFile(
              join(releaseRoot, candidate, "openapi.json"),
              "utf8",
            ),
          ),
        };
      } catch {
        // Ignore incomplete local artifact directories and continue to the last complete release.
      }
    }
  } catch {
    // The first repository release has no prior artifact directory.
  }
  return undefined;
}

const previous = await previousSpec();
const json = canonical(openApiSpec);
let commit = headCommit;
let timestamp = headTimestamp;
const declaration = generateOpenApiTypes(openApiSpec, {
  banner: `/* Generated from Tixkit OpenAPI ${version}. Do not edit. */`,
});
const webhookCatalog = {
  apiVersion: version,
  events: [
    ...WEBHOOK_EVENT_CATALOG,
    {
      type: "test.ping",
      subscribable: false,
      test: true,
      delivery: "at-least-once",
      ordering: "not-guaranteed",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["type", "test", "apiVersion", "createdAt", "data"],
        properties: {
          type: { const: "test.ping" },
          test: { const: true },
          apiVersion: { const: version },
          createdAt: { type: "string", format: "date-time" },
          data: {
            type: "object",
            additionalProperties: false,
            required: ["endpointId"],
            properties: { endpointId: { type: "string" } },
          },
        },
      },
    },
  ],
};
const examples = {
  apiVersion: version,
  examples: {
    error: {
      error: {
        code: "NOT_FOUND",
        message: "Resource not found",
        requestId: "req_example",
      },
    },
    webhookTest: {
      type: "test.ping",
      test: true,
      apiVersion: version,
      createdAt: "2026-01-01T00:00:00.000Z",
      data: { endpointId: "wh_example" },
    },
  },
};
const currentSpec = openApiSpec as unknown as JsonObject;
const changes = previous
  ? compareOpenApi(previous.spec as never, currentSpec as never)
  : [];
const breakingChanges = changes.filter(
  (change) => change.severity === "breaking",
);
const apiDiff = {
  from: previous?.version ?? null,
  to: version,
  initialRelease: !previous,
  breaking: breakingChanges.length > 0,
  summary: {
    breaking: breakingChanges.length,
    compatible: changes.length - breakingChanges.length,
  },
  changes,
};
if (apiDiff.breaking && previous?.version === version) {
  throw new Error(
    "Breaking changes may never rewrite an immutable API version. Choose a newer version.",
  );
}
if (apiDiff.breaking && process.env.ALLOW_BREAKING_API_RELEASE !== "1") {
  throw new Error(
    "Breaking API changes detected. Set ALLOW_BREAKING_API_RELEASE=1 only after protected approval.",
  );
}
if (apiDiff.breaking && previous) {
  if (version <= previous.version)
    throw new Error("A breaking API release must use a newer date version.");
  await access(
    resolve(
      root,
      "docs/public/reference/migrations",
      `${previous.version}-to-${version}.mdx`,
    ),
  ).catch(() => {
    throw new Error(
      "Approved breaking releases require a checked-in version migration guide.",
    );
  });
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const changelog = `# API ${version}\n\n${
  previous
    ? `Compared with ${previous.version}. Breaking changes: ${breakingChanges.length}. Compatible changes: ${changes.length - breakingChanges.length}.`
    : "Initial versioned repository contract release."
}\n\n- OpenAPI JSON and YAML\n- Generated TypeScript declarations\n- Webhook event catalog\n- Sanitized request/response examples\n- Machine-readable API diff and checksums\n`;

const files = new Map<string, string>([
  ["openapi.json", json],
  ["openapi.yaml", stringify(JSON.parse(json), { lineWidth: 0 })],
  ["openapi.d.ts", declaration],
  ["webhook-events.json", canonical(webhookCatalog)],
  ["examples.json", canonical(examples)],
  ["api-diff.json", canonical(apiDiff)],
  ["CHANGELOG.md", changelog],
]);
if (previous?.version === version) {
  try {
    const priorManifest = JSON.parse(
      await readFile(join(output, "release-manifest.json"), "utf8"),
    );
    const priorArtifacts = new Map<
      string,
      { name: string; sha256: string; size: number }
    >(
      priorManifest.artifacts.map(
        (artifact: { name: string; sha256: string; size: number }) => [
          artifact.name,
          artifact,
        ],
      ),
    );
    const deterministicPayloadMatches =
      priorArtifacts.size === files.size &&
      [...files].every(([name, contents]) => {
        const prior = priorArtifacts.get(name);
        return (
          prior?.sha256 === sha256(contents) &&
          prior.size === Buffer.byteLength(contents)
        );
      });
    if (
      deterministicPayloadMatches &&
      typeof priorManifest.commit === "string" &&
      typeof priorManifest.timestamp === "string"
    ) {
      commit = priorManifest.commit;
      timestamp = priorManifest.timestamp;
    }
  } catch {
    // A missing, invalid, or incomplete manifest is rebuilt from the current source commit.
  }
}
for (const [name, contents] of files) {
  assertPublicArtifactSafe(name, contents);
  await writeFile(join(output, name), contents);
}

const artifacts = [...files].map(([name, contents]) => ({
  name,
  sha256: sha256(contents),
  size: Buffer.byteLength(contents),
}));
const manifest = canonical({
  releaseVersion: version,
  apiVersion: version,
  commit,
  timestamp,
  artifacts,
  breaking: apiDiff.breaking,
  publication: "approval-required",
});
await writeFile(join(output, "release-manifest.json"), manifest);
const checksumLines = [
  ...artifacts,
  { name: "release-manifest.json", sha256: sha256(manifest) },
]
  .map((artifact) => `${artifact.sha256}  ${artifact.name}`)
  .join("\n");
await writeFile(join(output, "CHECKSUMS.sha256"), `${checksumLines}\n`);
const docsOutput = resolve(root, "apps/docs/public/contracts", version);
await rm(docsOutput, { recursive: true, force: true });
await mkdir(docsOutput, { recursive: true });
for (const name of [
  ...files.keys(),
  "release-manifest.json",
  "CHECKSUMS.sha256",
]) {
  await copyFile(join(output, name), join(docsOutput, name));
}
const releaseVersions = (await readdir(releaseRoot))
  .filter((candidate) => /^\d{4}-\d{2}-\d{2}$/u.test(candidate))
  .sort()
  .reverse();
await writeFile(
  resolve(root, "apps/docs/src/generated/api-release-index.ts"),
  `/* Generated by scripts/build-api-release.ts. Do not edit. */\nexport const apiReleaseVersions = ${JSON.stringify(releaseVersions)} as const;\n`,
);

console.log(
  `Built API release ${version} (${artifacts.length + 2} artifacts).`,
);
