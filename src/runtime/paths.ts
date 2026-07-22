import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function resolveProjectRoot(extensionUrlOrDir: string): string {
  const extensionDir = extensionUrlOrDir.startsWith("file:")
    ? dirname(fileURLToPath(extensionUrlOrDir))
    : extensionUrlOrDir;

  return resolve(extensionDir);
}

// Extensions no longer all live at the repo root: core.ts is under extensions/
// and the feature extensions under extensions/<name>/. So an extension can no
// longer assume its own directory is the project root. Walk up from the
// extension file until we hit the directory holding package.json — the single
// project root every extension must resolve to so skill/prompt/settings paths
// (and the sqlite default) line up regardless of how deep the entry file sits.
export function findProjectRoot(extensionUrl: string): string {
  let dir = resolveProjectRoot(extensionUrl);
  while (true) {
    if (existsSync(resolve(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // Reached filesystem root without finding package.json; fall back to the
      // extension's own directory rather than throwing during activation.
      return resolveProjectRoot(extensionUrl);
    }
    dir = parent;
  }
}

