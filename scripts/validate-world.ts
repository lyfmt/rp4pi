import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MANIFEST_FILENAME, WORLDS_DIRNAME } from "../src/world/loader.ts";
import { defaultTargets, validateWorldDir } from "../src/world/validate-world.ts";

// `npm run validate-world [--] [name...]` — thin CLI over the validate-world
// library (src/world/validate-world.ts): load-and-validate world packs without
// booting the runtime. No names → every non-`_`-prefixed directory under
// worlds/; explicit names may include `_`-prefixed packs (so _template itself
// stays checkable).

function main(): void {
  const projectRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const worldsBase = join(projectRoot, WORLDS_DIRNAME);

  // npm strips a lone `--` before the script args; drop a stray one anyway.
  const names = process.argv.slice(2).filter((arg) => arg !== "--");
  const targets = names.length > 0 ? names : defaultTargets(worldsBase);
  if (targets.length === 0) {
    console.error(`No world packs found under ${worldsBase}. Expected at least one <name>/${MANIFEST_FILENAME}.`);
    process.exitCode = 1;
    return;
  }

  let failures = 0;
  for (const name of targets) {
    const result = validateWorldDir(join(worldsBase, name));
    if (result.ok) {
      console.log(`ok    ${result.dir}`);
    } else {
      failures += 1;
      console.error(`FAIL  ${result.dir}`);
      console.error(indent(result.error ?? "unknown error"));
    }
    for (const warning of result.warnings) {
      console.warn(indent(`warn: ${warning}`));
    }
  }

  console.log(`${targets.length} world(s) checked, ${failures} failed.`);
  process.exitCode = failures > 0 ? 1 : 0;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
}

main();
