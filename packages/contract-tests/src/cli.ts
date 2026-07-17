#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {
  testEmbedHostContract,
  testSdkConsumerContract,
  testWebhookConsumerContract,
  runSdkApiConsumerContract,
  runAgentPlatformContract,
} from './index.js';
import { executeContractTestRequest, issueContractTestRequestUrl } from './runtime-target.js';

const [profile, fixturePath] = process.argv.slice(2);
if (!profile || !fixturePath)
  throw new Error('Usage: tixkit-contract-tests <profile> <fixture.json>');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>;
const embedFixture = (() => {
  if (profile !== 'embed-host') return fixture;
  const sharedSources = new Map<string, object>();
  const messageEvents = Array.isArray(fixture.messageEvents)
    ? fixture.messageEvents.map((captured) => {
        const value = captured as Record<string, unknown>;
        const sourceKey = typeof value.sourceKey === 'string' ? value.sourceKey : 'default';
        const source = sharedSources.get(sourceKey) ?? {};
        sharedSources.set(sourceKey, source);
        const event = (value.event ?? {}) as Record<string, unknown>;
        const expectation = (value.expectation ?? {}) as Record<string, unknown>;
        return {
          ...value,
          event: { ...event, source },
          expectation: {
            ...expectation,
            source: value.sourceMatches === false ? {} : source,
          },
        };
      })
    : [];
  return {
    ...fixture,
    artifact: new Uint8Array(Array.isArray(fixture.artifact) ? fixture.artifact : []),
    messageEvents,
  };
})();
let output =
  profile === 'embed-host'
    ? testEmbedHostContract(embedFixture as Parameters<typeof testEmbedHostContract>[0])
    : profile === 'webhook-consumer'
      ? testWebhookConsumerContract(fixture as Parameters<typeof testWebhookConsumerContract>[0])
      : profile === 'sdk-consumer'
        ? testSdkConsumerContract(fixture as Parameters<typeof testSdkConsumerContract>[0])
        : undefined;
if (profile === 'sdk-consumer' && fixture && typeof fixture === 'object' && 'baseUrl' in fixture) {
  const live = fixture as unknown as {
    baseUrl: string;
    apiKey: string;
    apiVersion: string;
    endpointId: string;
  };
  output = await runSdkApiConsumerContract({
    apiKey: live.apiKey,
    apiVersion: live.apiVersion,
    endpointId: live.endpointId,
    execute: async (request) => {
      const response = await executeContractTestRequest(live.baseUrl, request.path, {
        method: request.method,
        headers: request.headers,
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.json().catch(() => null),
      };
    },
  });
}
if (profile === 'agent-platform' && fixture && typeof fixture === 'object') {
  const live = fixture as unknown as {
    baseUrl: string;
    apiVersion: string;
    sponsorAccessTokenEnv: string;
    agentClientId: string;
    agentClientSecretEnv: string;
    delegationGrantId: string;
    resourceId: string;
    campaignEmailTemplateKey: string;
    planId: string;
    idempotencyPrefix: string;
  };
  const sponsorAccessToken = process.env[live.sponsorAccessTokenEnv];
  const agentClientSecret = process.env[live.agentClientSecretEnv];
  if (!sponsorAccessToken || !agentClientSecret)
    throw new Error('Agent platform credential environment variables are not set.');
  issueContractTestRequestUrl(live.baseUrl, '/');
  output = await runAgentPlatformContract({
    ...live,
    sponsorAccessToken,
    agentClientSecret,
    execute: async (request) => {
      const response = await executeContractTestRequest(live.baseUrl, request.path, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.json().catch(() => null),
      };
    },
  });
}
if (!output) throw new Error(`Unknown contract profile: ${profile}`);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (!output.ok) process.exitCode = 1;
