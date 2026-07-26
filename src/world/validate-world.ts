import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { loadWorldFromDir } from "./loader.ts";

// Library half of `npm run validate-world` (the CLI entry lives in
// scripts/validate-world.ts, per the repo convention that executable
// entrypoints go under scripts/ and src/ stays import-only). A pack passes iff
// loadWorldFromDir succeeds, which exercises the full manifest contract:
// structure, referenced files, paths. `name` ≠ directory name is a warning,
// not a failure: lore is keyed by `name`, so a template copied without editing
// `name` would silently share a lore DB.

export type WorldValidationResult = {
  /** Directory name under worlds/. */
  dir: string;
  ok: boolean;
  /** Load/validation error message when !ok. */
  error?: string;
  warnings: string[];
};

/** Validate one world pack directory. Exported for tests. */
export function validateWorldDir(worldRoot: string): WorldValidationResult {
  const dir = basename(worldRoot);
  try {
    const world = loadWorldFromDir(worldRoot);
    const warnings: string[] = [];
    if (world.name !== dir) {
      warnings.push(
        `manifest name "${world.name}" does not match directory name "${dir}". ` +
          `Lore is keyed by name — update \`name\` after copying a template.`
      );
    }
    return { dir, ok: true, warnings };
  } catch (error) {
    return { dir, ok: false, error: error instanceof Error ? error.message : String(error), warnings: [] };
  }
}

// Default target set: every non-`_`-prefixed directory under worlds/, with or
// without a manifest — a world someone forgot to give a world.yaml should fail
// validation, not be silently skipped. (This is exactly the union the old
// listWorldNames-plus-rescan two-step produced, in one readdir pass.)
export function defaultTargets(worldsBase: string): string[] {
  if (!existsSync(worldsBase)) {
    return [];
  }
  return readdirSync(worldsBase)
    .filter((entry) => {
      if (entry.startsWith("_")) {
        return false;
      }
      try {
        return statSync(join(worldsBase, entry)).isDirectory();
      } catch {
        // A dangling symlink (or otherwise unstat-able entry) stays a target:
        // validateWorldDir reports it as FAIL ("World manifest missing"), the
        // same as a directory without a manifest — never an uncaught crash and
        // never a silent skip.
        return true;
      }
    })
    .sort();
}
