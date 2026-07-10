import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { generateEmbedSnippet } from '../packages/embed-core/src/index.ts';

const root = resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');
const scriptUrl = 'http://localhost:3201/tixkit-widget.js';
const checkoutBaseUrl = 'http://localhost:3201';
const hostOrigin = 'http://localhost:3201';

function withoutLoader(snippet) {
  return snippet.replace(
    /^<!-- Tixkit Embed Contract [^\n]+ -->\n<script[^>]+><\/script>\n\n/u,
    '',
  );
}

const webflowWidget = generateEmbedSnippet({
  eventId: 'evt_demo',
  brandId: 'brd_demo',
  mode: 'inline',
  platform: 'webflow',
  trackingId: 'webflow_test',
  widgetScriptUrl: scriptUrl,
  checkoutBaseUrl,
  hostOrigin,
  includeLifecycle: true,
});
const webflowButton = withoutLoader(
  generateEmbedSnippet({
    eventId: 'evt_demo',
    brandId: 'brd_demo',
    mode: 'button',
    platform: 'webflow',
    items: 'tt_general=2',
    widgetScriptUrl: scriptUrl,
    checkoutBaseUrl,
    hostOrigin,
  }),
);

const framerWidget = generateEmbedSnippet({
  eventId: 'evt_demo',
  brandId: 'brd_demo',
  mode: 'modal',
  platform: 'framer',
  theme: 'dark',
  locale: 'en',
  trackingId: 'framer_test',
  widgetScriptUrl: scriptUrl,
  checkoutBaseUrl,
  hostOrigin,
  includeLifecycle: true,
});

const files = {
  'e2e/fixtures/embed-webflow.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Webflow Embed Fixture</title>
  </head>
  <body>
    <main>
      <h1>Demo Event Page</h1>
      <p>This page simulates a Webflow site with Tixkit Embed Contract 1.0.</p>
      ${webflowWidget}
      ${webflowButton}
    </main>
  </body>
</html>
`,
  'e2e/fixtures/embed-framer.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Framer Embed Fixture</title>
  </head>
  <body>
    <main>
      <h1>Framer Demo Page</h1>
      <p>This page simulates a Framer site with Tixkit Embed Contract 1.0.</p>
      ${framerWidget}
    </main>
  </body>
</html>
`,
};

let stale = false;
for (const [relativePath, content] of Object.entries(files)) {
  const file = resolve(root, relativePath);
  if (check) {
    const current = await readFile(file, 'utf8').catch(() => '');
    if (current !== content) {
      console.error(`${relativePath} is stale. Run bun run sync:embed-fixtures.`);
      stale = true;
    }
  } else {
    await writeFile(file, content, 'utf8');
  }
}

if (stale) process.exitCode = 1;
else console.log(check ? 'Embed fixtures match @tixkit/embed-core.' : 'Updated embed fixtures.');
