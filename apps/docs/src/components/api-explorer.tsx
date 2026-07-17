'use client';

import { useMemo, useState } from 'react';
import { executeApiExplorerRequest, issueApiExplorerRequestUrl } from './api-explorer-target';

type Operation = { operationId: string; method: string; path: string; summary: string };

export function ApiExplorer({
  operations,
  version,
  allowedOrigins,
}: {
  operations: Operation[];
  version: string;
  allowedOrigins: string[];
}) {
  const [operationId, setOperationId] = useState(operations[0]?.operationId ?? '');
  const [requestPath, setRequestPath] = useState(operations[0]?.path ?? '');
  const [baseUrl, setBaseUrl] = useState(allowedOrigins[0] ?? '');
  const [apiKey, setApiKey] = useState('');
  const [body, setBody] = useState('{}');
  const [result, setResult] = useState('');
  const [status, setStatus] = useState('');
  const [failure, setFailure] = useState('');
  const [running, setRunning] = useState(false);
  const [mutationConfirmed, setMutationConfirmed] = useState(false);
  const operation = useMemo(
    () => operations.find((candidate) => candidate.operationId === operationId),
    [operationId, operations],
  );
  const mutation = operation?.method !== 'GET';
  const unresolvedPath = /[{}]/u.test(requestPath);
  const sandboxCredential = /^tk_sandbox_[a-f0-9]{64}$/u.test(apiKey);
  const url = useMemo(() => {
    if (!operation) return '';
    try {
      return issueApiExplorerRequestUrl({ allowedOrigins, selectedOrigin: baseUrl, requestPath });
    } catch {
      return '';
    }
  }, [allowedOrigins, baseUrl, operation, requestPath]);
  const resetConsent = () => setMutationConfirmed(false);

  async function execute() {
    if (!operation || !apiKey || !allowedOrigins.includes(baseUrl)) return;
    setRunning(true);
    setResult('');
    setStatus('Sending sandbox request.');
    setFailure('');
    try {
      const response = await executeApiExplorerRequest(
        { allowedOrigins, selectedOrigin: baseUrl, requestPath },
        {
          method: operation.method,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'X-Tixkit-Version': version,
            Accept: 'application/json',
            ...(operation.method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(operation.method === 'GET' ? {} : { body }),
        },
      );
      const text = await response.text();
      setResult(`${response.status} ${response.statusText}\n${text.slice(0, 20_000)}`);
      if (response.ok) setStatus(`Sandbox request completed with status ${response.status}.`);
      else setFailure(`Sandbox returned HTTP ${response.status}. Review the response body.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sandbox request failed.';
      setFailure(message);
      setResult(message);
    } finally {
      setRunning(false);
      resetConsent();
    }
  }

  const curl = operation
    ? [
        `curl --request ${operation.method} '${url}'`,
        "--header 'Authorization: Bearer $TIXKIT_API_KEY'",
        `--header 'X-Tixkit-Version: ${version}'`,
        ...(operation.method === 'GET'
          ? []
          : ["--header 'Content-Type: application/json'", `--data '${body}'`]),
      ].join(' ')
    : '';

  return (
    <section aria-labelledby="api-explorer-heading">
      <h2 id="api-explorer-heading">Sandbox API explorer</h2>
      <p>Credentials stay in memory and are sent only to the configured sandbox origin.</p>
      <label>
        API version
        <select value={version} disabled>
          <option>{version}</option>
        </select>
      </label>
      <label>
        Operation
        <select
          value={operationId}
          onChange={(event) => {
            const next = operations.find(
              (candidate) => candidate.operationId === event.target.value,
            );
            setOperationId(event.target.value);
            setRequestPath(next?.path ?? '');
            resetConsent();
          }}
        >
          {operations.map((candidate) => (
            <option value={candidate.operationId} key={candidate.operationId}>
              {candidate.method} {candidate.path} — {candidate.summary}
            </option>
          ))}
        </select>
      </label>
      <label>
        Request path (replace path parameters)
        <input
          value={requestPath}
          onChange={(event) => {
            setRequestPath(event.target.value);
            resetConsent();
          }}
        />
      </label>
      {allowedOrigins.length ? (
        <label>
          Sandbox origin
          <select
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              resetConsent();
            }}
          >
            {allowedOrigins.map((origin) => (
              <option key={origin}>{origin}</option>
            ))}
          </select>
        </label>
      ) : (
        <output>Sandbox execution is unavailable in this deployment.</output>
      )}
      <label>
        Sandbox API key
        <input
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            resetConsent();
          }}
          type="password"
          autoComplete="off"
        />
      </label>
      {mutation ? (
        <>
          <label>
            JSON request body
            <textarea
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                resetConsent();
              }}
              rows={8}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={mutationConfirmed}
              onChange={(event) => setMutationConfirmed(event.target.checked)}
            />
            I confirm this exact request may change sandbox state.
          </label>
        </>
      ) : null}
      <button
        type="button"
        onClick={execute}
        disabled={
          !allowedOrigins.length ||
          !apiKey ||
          !sandboxCredential ||
          running ||
          !operation ||
          !url ||
          unresolvedPath ||
          (mutation && !mutationConfirmed)
        }
      >
        {running ? 'Sending…' : 'Send sandbox request'}
      </button>
      {unresolvedPath ? <p role="alert">Replace every path parameter before sending.</p> : null}
      {apiKey && !sandboxCredential ? (
        <p role="alert">
          Only an expiring <code>tk_sandbox_</code> credential is accepted.
        </p>
      ) : null}
      <output aria-live="polite" aria-busy={running}>
        {status}
      </output>
      {failure ? <p role="alert">{failure}</p> : null}
      <details>
        <summary>cURL</summary>
        <pre>
          <code>{curl}</code>
        </pre>
      </details>
      <figure>
        <figcaption>Sandbox response body</figcaption>
        <pre>{result}</pre>
      </figure>
    </section>
  );
}
