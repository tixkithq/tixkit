import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { findRepoRoot } from './env.js';

const execFileAsync = promisify(execFile);

export type ScaffoldTemplate = 'nextjs' | 'vue' | 'astro' | 'remix';

export interface ScaffoldOptions {
  targetDir: string;
  template: ScaffoldTemplate;
  projectName: string;
  port?: number;
  brandId?: string;
  eventId?: string;
  ticketTypeId?: string;
  install?: boolean;
  skipGit?: boolean;
}

interface TemplateEntry {
  source: string;
  destination: string;
}

const templateDirFor = (template: ScaffoldTemplate): string =>
  fileURLToPath(new URL(`templates/${template}`, import.meta.url));

export const SCAFFOLD_TEMPLATES: ScaffoldTemplate[] = ['nextjs', 'vue', 'astro', 'remix'];

export function scaffoldTemplateDescription(template: ScaffoldTemplate): string {
  switch (template) {
    case 'nextjs':
      return 'Next.js App Router app with @tixkit/next';
    case 'vue':
      return 'Nuxt 3 app with @tixkit/vue';
    case 'astro':
      return 'Astro app with @tixkit/astro';
    case 'remix':
      return 'Remix app with @tixkit/remix';
    default:
      return template;
  }
}

export function kebabCase(input: string): string {
  return input
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

export function normalizeProjectName(input: string): string {
  return kebabCase(input);
}

export function titleCase(input: string): string {
  return kebabCase(input)
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export async function* walkTemplates(root: string, current = root): AsyncGenerator<TemplateEntry> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(current, entry.name);
    if (entry.isDirectory()) {
      yield* walkTemplates(root, source);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.template')) continue;
    const relative = path.relative(root, source).replace(/\.template$/, '');
    yield { source, destination: relative };
  }
}

export function relativeRepoRoot(targetDir: string, repoRoot: string): string {
  const rel = path.relative(targetDir, repoRoot);
  return rel === '' ? '.' : rel;
}

export async function renderTemplate(
  source: string,
  options: ScaffoldOptions,
  repoRoot: string,
): Promise<string> {
  const content = await readFile(source, 'utf8');
  const port = String(options.port ?? 3000);
  const root = relativeRepoRoot(options.targetDir, repoRoot);
  return content
    .replace(/__NAME__/g, options.projectName)
    .replace(/__TITLE__/g, titleCase(options.projectName))
    .replace(/__PORT__/g, port)
    .replace(/__ROOT__/g, root)
    .replace(/__BRAND_ID__/g, options.brandId ?? 'brd_demo')
    .replace(/__EVENT_ID__/g, options.eventId ?? 'evt_demo')
    .replace(/__TICKET_TYPE_ID__/g, options.ticketTypeId ?? 'tt_demo_general');
}

const VALID_PROJECT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function scaffold(
  options: ScaffoldOptions,
): Promise<{ ok: boolean; message: string }> {
  try {
    if (!VALID_PROJECT_NAME.test(options.projectName)) {
      return {
        ok: false,
        message: `Invalid project name "${options.projectName}". Use lowercase letters, numbers, and hyphens only (e.g. my-event-app).`,
      };
    }

    await mkdir(options.targetDir, { recursive: true });
    const existing = await readdir(options.targetDir).catch(() => []);
    if (existing.length > 0) {
      return {
        ok: false,
        message: `Target directory is not empty: ${options.targetDir}`,
      };
    }

    let repoRoot: string;
    try {
      repoRoot = await findRepoRoot(options.targetDir);
    } catch {
      return {
        ok: false,
        message: `Target directory must be inside the Tixkit monorepo so workspace:* dependencies resolve. Received: ${options.targetDir}`,
      };
    }
    const relToRepo = path.relative(repoRoot, path.resolve(options.targetDir));
    if (relToRepo.startsWith('..') || path.isAbsolute(relToRepo)) {
      return {
        ok: false,
        message: `Target directory must be inside the Tixkit monorepo so workspace:* dependencies resolve. Received: ${options.targetDir}`,
      };
    }

    for await (const entry of walkTemplates(templateDirFor(options.template))) {
      const destination = path.join(options.targetDir, entry.destination);
      await mkdir(path.dirname(destination), { recursive: true });
      const rendered = await renderTemplate(entry.source, options, repoRoot);
      await writeFile(destination, rendered, 'utf8');
    }

    if (options.install) {
      try {
        await execFileAsync('bun', ['install'], { cwd: options.targetDir });
      } catch (err) {
        return {
          ok: false,
          message: `Scaffolded to ${options.targetDir}, but dependency install failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return {
      ok: true,
      message: [
        `Scaffolded ${options.template} app at ${options.targetDir}`,
        '',
        'Next steps:',
        `  cd ${options.targetDir}`,
        '  cp .env.local.example .env.local',
        '  # Edit .env.local with your Tixkit API key and webhook secret',
        '  bun run typecheck',
        '  bun run dev',
      ].join('\n'),
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
