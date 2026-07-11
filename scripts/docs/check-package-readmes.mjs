import { assertNoErrors, rootFromMeta, validatePackageReadmes } from './lib/content.mjs';

export const checkPackageReadmes = validatePackageReadmes;

if (process.argv[1] === new URL(import.meta.url).pathname)
  assertNoErrors(checkPackageReadmes(rootFromMeta(import.meta.url)), 'package READMEs');
