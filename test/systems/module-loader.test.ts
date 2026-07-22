import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { loadSystemDefinitions } from "../../src/systems/module-loader.ts";

const defineSystemUrl = pathToFileURL(new URL("../../src/systems/define-system.ts", import.meta.url).pathname).href;

function withModules(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "rp-system-modules-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function definitionExpression(name: string): string {
  return `defineSystem({
    name: ${JSON.stringify(name)},
    version: 1,
    initialize: () => ({ value: 0 }),
    parse: (payload) => payload,
    commands: {},
    project: (_context, state) => state
  })`;
}

test("loadSystemDefinitions preserves file and export key order", () => {
  withModules((directory) => {
    const firstPath = join(directory, "first.ts");
    const secondPath = join(directory, "second.ts");
    writeFileSync(
      firstPath,
      [
        `import { defineSystem } from ${JSON.stringify(defineSystemUrl)};`,
        `export const first = ${definitionExpression("alpha")};`,
        `export const second = ${definitionExpression("beta")};`
      ].join("\n")
    );
    writeFileSync(
      secondPath,
      [
        `import { defineSystem } from ${JSON.stringify(defineSystemUrl)};`,
        `export const third = ${definitionExpression("gamma")};`
      ].join("\n")
    );

    assert.deepEqual(loadSystemDefinitions([firstPath, secondPath]).map((definition) => definition.name), [
      "alpha",
      "beta",
      "gamma"
    ]);
  });
});

test("loadSystemDefinitions accepts definitions created by another factory module instance", () => {
  withModules((directory) => {
    const modulePath = join(directory, "cross-loader.ts");
    writeFileSync(
      modulePath,
      [
        `import { defineSystem } from ${JSON.stringify(`${defineSystemUrl}?instance=system-module`)};`,
        `export const crossLoader = ${definitionExpression("cross-loader")};`
      ].join("\n")
    );

    assert.deepEqual(loadSystemDefinitions([modulePath]).map((definition) => definition.name), [
      "cross-loader"
    ]);
  });
});

test("loadSystemDefinitions rejects modules without a SystemDefinition export", () => {
  withModules((directory) => {
    const modulePath = join(directory, "empty.ts");
    writeFileSync(modulePath, "export const marker = true;\n");

    assert.throws(
      () => loadSystemDefinitions([modulePath]),
      (error) => error instanceof Error && error.message.includes(modulePath)
    );
  });
});

test("loadSystemDefinitions collects the same definition object only once", () => {
  withModules((directory) => {
    const modulePath = join(directory, "aliases.ts");
    writeFileSync(
      modulePath,
      [
        `import { defineSystem } from ${JSON.stringify(defineSystemUrl)};`,
        `const shared = ${definitionExpression("shared")};`,
        "export { shared, shared as alias };"
      ].join("\n")
    );

    const definitions = loadSystemDefinitions([modulePath]);

    assert.equal(definitions.length, 1);
    assert.equal(definitions[0]?.name, "shared");
  });
});

test("loadSystemDefinitions reports the module path when loading throws", () => {
  withModules((directory) => {
    const modulePath = join(directory, "broken.ts");
    writeFileSync(modulePath, 'throw new Error("module exploded");\n');

    assert.throws(
      () => loadSystemDefinitions([modulePath]),
      (error) =>
        error instanceof Error &&
        error.message.includes(modulePath) &&
        error.message.includes("module exploded")
    );
  });
});
