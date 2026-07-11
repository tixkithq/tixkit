import { sdkSnippetRegistry } from '@tixkit/docs-core';
import guideSections from '../../../../docs/sdk-guide-sections.json';
import { CodeBlock } from './code-block';

const sectionTitle = Object.fromEntries(
  guideSections.map((section) => [section.id, section.title]),
);

export function SdkGuide({ sdkId }: { sdkId: string }) {
  const sdk = sdkSnippetRegistry.find((entry) => entry.id === sdkId);
  if (!sdk) throw new Error(`Unknown SDK guide: ${sdkId}`);
  const mobile = sdk.runtime === 'mobile';
  return (
    <>
      <h2 id="install">{sectionTitle.install}</h2>
      <p>
        Install <code>{sdk.packageName}</code> for a {sdk.runtime} runtime. This beta package
        targets API version <code>{sdk.apiVersion}</code>.
      </p>
      <CodeBlock>
        <code className="language-bash">{sdk.install}</code>
      </CodeBlock>

      <h2 id="configure">{sectionTitle.configure}</h2>
      <p>
        {mobile
          ? 'Provide the API base URL and a platform secure-storage adapter. Obtain short-lived scanner credentials from your trusted backend; never bundle a server API key in the application.'
          : `Set ${sdk.requiredEnvironment.join(' and ')} only in the server environment. Never expose the key through a public build variable, URL, log, or browser storage.`}
      </p>
      <CodeBlock>
        <code>{sdk.initialization}</code>
      </CodeBlock>

      <h2 id="first-request">{sectionTitle['first-request']}</h2>
      <CodeBlock>
        <code>{sdk.firstRequest}</code>
      </CodeBlock>
      <p>
        Expected result:{' '}
        {mobile
          ? 'a typed scan decision with an accepted or rejected status and reason.'
          : 'a typed event page; an empty items array is a successful response when the workspace has no events.'}
      </p>

      <h2 id="troubleshoot">{sectionTitle.troubleshoot}</h2>
      <ul>
        <li>
          <strong>Unauthorized:</strong> verify the credential is current, server-side, and scoped
          for the requested operation.
        </li>
        <li>
          <strong>Connection failure:</strong> verify the API base URL includes the intended
          environment and that its health endpoint is reachable.
        </li>
        <li>
          <strong>Version or type mismatch:</strong> align the package and server with API version{' '}
          <code>{sdk.apiVersion}</code>, then rebuild the client.
        </li>
        {mobile ? (
          <li>
            <strong>Scanner unavailable:</strong> confirm the secure-storage bridge is installed and
            the device credential has not expired.
          </li>
        ) : null}
      </ul>

      <h2 id="verify-and-continue">{sectionTitle['verify-and-continue']}</h2>
      <p>
        Run the maintained fixture at <code>{sdk.demoPath}</code>. After the first request succeeds,
        continue to <a href="/developers/api-fundamentals/errors">errors and retries</a> and the{' '}
        <a href="/reference/api">generated API reference</a>.
      </p>
    </>
  );
}
