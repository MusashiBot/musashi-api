import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** True when this file is the process entrypoint (ESM-safe replacement for require.main). */
export function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}
