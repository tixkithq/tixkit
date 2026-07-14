import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export function packageContentDigest(packageRoot) {
  const root = resolve(packageRoot);
  const hash = createHash('sha256');
  let fileCount = 0;

  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name);
      const metadata = lstatSync(path);
      const packagePath = relative(root, path).split(sep).join('/');
      if (metadata.isSymbolicLink())
        throw new Error(`public package content contains a symbolic link: ${packagePath}`);
      if (metadata.isDirectory()) {
        visit(path);
        continue;
      }
      if (!metadata.isFile())
        throw new Error(`public package content contains an unsupported entry: ${packagePath}`);
      const bytes = readFileSync(path);
      const mode = (metadata.mode & 0o777).toString(8).padStart(3, '0');
      hash.update(packagePath);
      hash.update('\0');
      hash.update(`file:${mode}`);
      hash.update('\0');
      hash.update(String(bytes.byteLength));
      hash.update('\0');
      hash.update(bytes);
      hash.update('\0');
      fileCount += 1;
    }
  };

  visit(root);
  if (fileCount === 0) throw new Error('public package content must contain at least one file');
  return { contentSha256: hash.digest('hex'), fileCount };
}
