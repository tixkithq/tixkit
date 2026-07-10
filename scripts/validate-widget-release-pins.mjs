import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'artifacts/widget/manifest.json'), 'utf8'));
const expectedUrl = `https://cdn.tixkit.com/widget/v${manifest.widgetVersion}/${manifest.files.widget.path}`;
const expectedIntegrity = manifest.files.widget.integrity;
const files = [
  'packages/cli/src/embed-generator.ts',
  'docs/embed-generator.html',
  'docs/public/developers/widget/embedding.mdx',
];
for (const file of files) {
  const content = readFileSync(resolve(root, file), 'utf8');
  let valid = false;
  if (file === 'packages/cli/src/embed-generator.ts')
    valid =
      content.includes(`'${expectedUrl}'`) &&
      content.includes(`'${expectedIntegrity}'`) &&
      content.includes('widgetScriptUrl: options.widgetScriptUrl ?? DEFAULT_WIDGET_SCRIPT') &&
      content.includes('widgetIntegrity: options.widgetIntegrity ?? DEFAULT_WIDGET_INTEGRITY');
  else if (file === 'docs/embed-generator.html')
    valid =
      new RegExp(`id="scriptUrl"[\\s\\S]{0,120}value="${expectedUrl.replaceAll('.', '\\.')}"`).test(
        content,
      ) &&
      new RegExp(
        `id="scriptIntegrity"[\\s\\S]{0,120}value="${expectedIntegrity.replaceAll('+', '\\+')}"`,
      ).test(content) &&
      /widgetScriptUrl:\s*scriptUrl/.test(content) &&
      /widgetIntegrity:\s*scriptIntegrity/.test(content);
  else {
    const productionTags = content.match(/<script\b[^>]*cdn\.tixkit\.com[^>]*><\/script>/gs) ?? [];
    valid =
      productionTags.length > 0 &&
      productionTags.every(
        (tag) =>
          tag.includes(`src="${expectedUrl}"`) && tag.includes(`integrity="${expectedIntegrity}"`),
      );
  }
  if (!valid) throw new Error(`${file} is not pinned to the current widget release manifest.`);
  if (/cdn\.tixkit\.com\/widget\/(?:latest\/)?tixkit-widget\.js/.test(content))
    throw new Error(`${file} contains a mutable production widget URL.`);
}
process.stdout.write(
  `Validated production widget URL and SRI pins for ${files.length} consumers.\n`,
);
