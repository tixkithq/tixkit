#!/usr/bin/env node
import { resolve } from 'node:path';
import { generateTixkitApiIntegrationSkill } from './index.js';

type Options = {
  releaseRoot?: string;
  apiVersion?: string;
  outputRoot?: string;
  expectedReleaseManifestSha256?: string;
  allowLocalEvaluation: boolean;
};

function parseOptions(argv: string[]): Options {
  const options: Options = { allowLocalEvaluation: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--allow-local-evaluation') {
      options.allowLocalEvaluation = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    if (argument === '--release-root') options.releaseRoot = value;
    else if (argument === '--api-version') options.apiVersion = value;
    else if (argument === '--output') options.outputRoot = value;
    else if (argument === '--expected-release-manifest-sha256')
      options.expectedReleaseManifestSha256 = value;
    else throw new Error(`Unknown option: ${argument}`);
    index += 1;
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (
    !options.releaseRoot ||
    !options.apiVersion ||
    !options.outputRoot ||
    !options.expectedReleaseManifestSha256
  ) {
    throw new Error(
      '--release-root, --api-version, --output, and --expected-release-manifest-sha256 are required',
    );
  }
  const result = await generateTixkitApiIntegrationSkill({
    releaseRoot: resolve(options.releaseRoot),
    apiVersion: options.apiVersion,
    outputRoot: resolve(options.outputRoot),
    allowLocalEvaluation: options.allowLocalEvaluation,
    expectedReleaseManifestSha256: options.expectedReleaseManifestSha256,
  });
  process.stdout.write(
    `${JSON.stringify({ apiVersion: result.apiVersion, directory: result.directory, localEvaluation: result.localEvaluation })}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown integration-skill failure';
  process.stderr.write(`Tixkit API skill generation failed: ${message}\n`);
  process.exitCode = 1;
});
