import path from 'node:path';
import { validateEnvFile, formatValidationResult } from './setup-check.js';
import { runDevWebhooks, formatWebhookResult } from './dev-webhooks.js';
import { seedSampleData } from './seed-sample-data.js';
import { runQuickstart } from './quickstart.js';
import { scaffold, SCAFFOLD_TEMPLATES, normalizeProjectName } from './scaffold.js';
import {
  generateEmbed,
  EMBED_MODES,
  EMBED_PLATFORMS,
  EMBED_THEMES,
  type EmbedMode,
  type EmbedPlatform,
  type EmbedTheme,
} from './embed-generator.js';

const args = process.argv.slice(2);
const command = args[0];

function help(): string {
  return [
    'tixkit CLI — local developer experience helpers',
    '',
    'Commands:',
    '  init                 Scaffold a new app using a Tixkit SDK template',
    '  embed:generate       Generate a no-code embed snippet for Webflow/Framer',
    '  setup:check          Validate .env.local for required and mode-specific values',
    '  dev:webhooks         Start Stripe CLI webhook forwarding for local development',
    '  seed:sample-data     Seed idempotent sample tenant / event / order data',
    '  quickstart           Start local infrastructure, apps, and sample data',
    '',
    'Options for init:',
    '  <dir>                Target directory (required)',
    '  --template <name>    Template to use (default: nextjs)',
    '  --project-name <name> Package name (default: directory name)',
    '  --port <number>      Dev server port (default: 3000)',
    '  --brand-id <id>      Demo brand identifier',
    '  --event-id <id>      Demo event identifier',
    '  --ticket-type-id <id> Demo ticket type identifier',
    '  --install            Run bun install after scaffolding',
    '  --skip-git           Skip git init in the target directory',
    '',
    'Options for embed:generate:',
    '  --event-id <id>       Event ID (required)',
    '  --brand-id <id>       Brand ID (required)',
    '  --mode <mode>         inline, modal, button, or redirect (default: inline)',
    '  --platform <name>     webflow, framer, or plain (default: webflow)',
    '  --theme <theme>       auto, light, or dark (default: auto)',
    '  --locale <locale>     Locale hint',
    '  --tracking-id <id>    Non-PII tracking/attribution ID',
    '  --products <ids>      Comma-separated ticket/product IDs',
    '  --items <items>       Comma-separated ticketTypeId=quantity pairs',
    '  --discount-code <code> Promo/access code to prefill',
    '  --checkout-url <url>  Checkout base URL (default: https://checkout.tixkit.com)',
    '  --script-url <url>    Widget script URL (default: https://cdn.tixkit.com/widget/tixkit-widget.js)',
    '  --allowed-origin <url> Host origin for CSP guidance',
    '  --lifecycle           Include lifecycle event listener script',
    '  --callback-name <name> Lifecycle callback function name (default: onTixkitEvent)',
    '',
    'Options for setup:check:',
    '  --env-file <path>    Path to env file (default: .env.local)',
    '  --mode <local|provider|production>',
    '',
    'Options for dev:webhooks:',
    '  --api-url <url>      API webhook target (default: http://localhost:4000)',
    '  --env-file <path>    Env file to update (default: .env.local)',
    '  --dry-run            Print planned forwarding without starting Stripe CLI',
    '  --no-write-secret    Capture secret but do not write it to the env file',
    '',
    'Options for quickstart:',
    '  --no-open            Do not open the browser after services are healthy',
    '  --skip-seed          Start services without seeding sample data',
  ].join('\n');
}

function parseArg<T extends string>(name: string, fallback: T): T {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? (args[index + 1] as T) : fallback;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

async function main(): Promise<void> {
  switch (command) {
    case 'init': {
      const targetDir = args[1];
      if (!targetDir) {
        console.log('Usage: tixkit init <dir> [options]');
        process.exit(1);
      }
      const template = parseArg<'nextjs'>('--template', 'nextjs');
      if (!SCAFFOLD_TEMPLATES.includes(template)) {
        console.log(`Unknown template "${template}". Available: ${SCAFFOLD_TEMPLATES.join(', ')}`);
        process.exit(1);
      }
      const rawProjectName = parseArg('--project-name', path.basename(targetDir));
      const projectName = normalizeProjectName(rawProjectName);
      const port = Number(parseArg('--port', '3000'));
      const brandId = parseArg('--brand-id', 'brd_demo');
      const eventId = parseArg('--event-id', 'evt_demo');
      const ticketTypeId = parseArg('--ticket-type-id', 'tt_demo_general');
      const install = hasFlag('--install');
      const skipGit = hasFlag('--skip-git');
      const result = await scaffold({
        targetDir,
        template,
        projectName,
        port,
        brandId,
        eventId,
        ticketTypeId,
        install,
        skipGit,
      });
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
    }

    case 'embed:generate': {
      const eventId = parseArg('--event-id', '');
      const brandId = parseArg('--brand-id', '');
      if (!eventId || !brandId) {
        console.log('Usage: tixkit embed:generate --event-id <id> --brand-id <id> [options]');
        process.exit(1);
      }
      const mode = parseArg('--mode', 'inline') as EmbedMode;
      if (!EMBED_MODES.includes(mode)) {
        console.log(`Unknown mode "${mode}". Available: ${EMBED_MODES.join(', ')}`);
        process.exit(1);
      }
      const platform = parseArg('--platform', 'webflow') as EmbedPlatform;
      if (!EMBED_PLATFORMS.includes(platform)) {
        console.log(`Unknown platform "${platform}". Available: ${EMBED_PLATFORMS.join(', ')}`);
        process.exit(1);
      }
      const theme = parseArg('--theme', 'auto') as EmbedTheme;
      if (!EMBED_THEMES.includes(theme)) {
        console.log(`Unknown theme "${theme}". Available: ${EMBED_THEMES.join(', ')}`);
        process.exit(1);
      }
      const embedResult = generateEmbed({
        eventId,
        brandId,
        mode,
        platform,
        theme,
        locale: parseArg('--locale', '') || undefined,
        trackingId: parseArg('--tracking-id', '') || undefined,
        products: parseArg('--products', '') || undefined,
        items: parseArg('--items', '') || undefined,
        discountCode: parseArg('--discount-code', '') || undefined,
        checkoutBaseUrl: parseArg('--checkout-url', '') || undefined,
        widgetScriptUrl: parseArg('--script-url', '') || undefined,
        allowedOrigin: parseArg('--allowed-origin', '') || undefined,
        includeLifecycle: hasFlag('--lifecycle'),
        lifecycleCallbackName: parseArg('--callback-name', '') || undefined,
      });
      if (!embedResult.ok) {
        console.log(embedResult.message);
        process.exit(1);
      }
      console.log('=== Embed Snippet ===\n');
      console.log(embedResult.snippet);
      console.log('\n=== CSP Guidance ===\n');
      console.log(embedResult.cspGuidance);
      console.log('\n=== Placement Instructions ===\n');
      console.log(embedResult.instructions);
      process.exit(0);
    }

    case 'setup:check': {
      const envFile = parseArg('--env-file', '.env.local');
      const mode = parseArg('--mode', 'local') as 'local' | 'provider' | 'production';
      const result = await validateEnvFile(envFile, mode);
      console.log(formatValidationResult(result));
      process.exit(result.ok ? 0 : 1);
    }

    case 'dev:webhooks': {
      const apiUrl = parseArg('--api-url', 'http://localhost:4000');
      const envFile = parseArg('--env-file', '.env.local');
      const dryRun = hasFlag('--dry-run');
      const writeSecret = !hasFlag('--no-write-secret');
      const result = await runDevWebhooks({ apiUrl, envFilePath: envFile, dryRun, writeSecret });
      console.log(formatWebhookResult(result));
      process.exit(result.ok ? 0 : 1);
    }

    case 'seed:sample-data': {
      const result = await seedSampleData();
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
    }

    case 'quickstart': {
      const noOpen = hasFlag('--no-open');
      const skipSeed = hasFlag('--skip-seed');
      const result = await runQuickstart({ open: !noOpen, seed: !skipSeed });
      if (!result.ok) {
        console.log(result.message);
        process.exit(1);
      }
      console.log(result.message);
      // Do not exit: the quickstart wrapper keeps the dev services managed in
      // the foreground until the child dev:all process exits or the user sends
      // Ctrl+C. The cleanup handlers registered in runQuickstart terminate the
      // child process group on SIGINT/SIGTERM.
      break;
    }

    default: {
      console.log(help());
      process.exit(command ? 1 : 0);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
