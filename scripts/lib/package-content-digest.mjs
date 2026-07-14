import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
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

export function directoryContentDigest(directoryRoot, containmentRoot = directoryRoot) {
  const root = realpathSync(directoryRoot);
  const containment = realpathSync(containmentRoot);
  const hash = createHash('sha256');
  let entryCount = 0;
  const withinContainment = (path) => {
    const pathFromRoot = relative(containment, path);
    return pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`));
  };

  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name);
      const metadata = lstatSync(path);
      const contentPath = relative(root, path).split(sep).join('/');
      const mode = (metadata.mode & 0o777).toString(8).padStart(3, '0');
      hash.update(contentPath);
      hash.update('\0');
      if (metadata.isSymbolicLink()) {
        const target = readlinkSync(path);
        let canonicalTarget;
        try {
          canonicalTarget = realpathSync(path);
        } catch {
          throw new Error(`installation contains a broken symbolic link: ${contentPath}`);
        }
        if (!withinContainment(canonicalTarget))
          throw new Error(`installation symbolic link escapes the repository: ${contentPath}`);
        hash.update(`symlink:${mode}`);
        hash.update('\0');
        hash.update(target);
      } else if (metadata.isDirectory()) {
        hash.update(`directory:${mode}`);
        visit(path);
      } else if (metadata.isFile()) {
        const bytes = readFileSync(path);
        hash.update(`file:${mode}`);
        hash.update('\0');
        hash.update(String(bytes.byteLength));
        hash.update('\0');
        hash.update(bytes);
      } else {
        throw new Error(`installation contains an unsupported entry: ${contentPath}`);
      }
      hash.update('\0');
      entryCount += 1;
    }
  };

  visit(root);
  return { contentSha256: hash.digest('hex'), entryCount };
}
