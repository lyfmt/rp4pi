import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  createRuntimeInfrastructure,
  getRuntimeInfrastructure,
  resetRuntimeInfrastructureForTest
} from "../../src/runtime/bootstrap.ts";
import { SystemRuntimeError } from "../../src/systems/errors.ts";

const defineSystemUrl = pathToFileURL(new URL("../../src/systems/define-system.ts", import.meta.url).pathname).href;

function writeProject(systemOptions: { capabilities?: string[] } = {}): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "rp-bootstrap-systems-"));
  const worldRoot = join(projectRoot, "worlds", "test-world");
  mkdirSync(join(worldRoot, "prompts"), { recursive: true });
  mkdirSync(join(worldRoot, "memory"), { recursive: true });
  mkdirSync(join(worldRoot, "systems"), { recursive: true });
  writeFileSync(join(worldRoot, "prompts", "gm.md"), "# GM\n");
  writeFileSync(join(worldRoot, "memory", "characters.yaml"), "memory_type: characters\n");
  writeFileSync(
    join(worldRoot, "world.yaml"),
    [
      "name: test-world",
      "state:",
      "  initial:",
      '    player: { name: "", status: ready, location: start }',
      "    time: { day: 1, hour: 8 }",
      "    scene: { summary: opening }",
      "prompts:",
      "  gm: [ ./prompts/gm.md ]",
      "memory:",
      "  policy:",
      "    self: { enabled: true }",
      "    peer: { enabled: false }",
      "    memory_types: [ characters ]",
      "  schemas: [ ./memory/characters.yaml ]",
      "  fallback_memory_types: [ entities ]",
      "systems:",
      "  - ./systems/progression.ts",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(worldRoot, "systems", "progression.ts"),
    [
      `import { defineSystem } from ${JSON.stringify(defineSystemUrl)};`,
      "export const progression = defineSystem({",
      '  name: "progression",',
      "  version: 2,",
      `  capabilities: ${JSON.stringify(systemOptions.capabilities ?? [])},`,
      '  initialize: () => { throw new Error("bootstrap must not initialize save state"); },',
      "  parse: (payload) => payload,",
      "  commands: {},",
      "  project: (_context, state) => state",
      "});",
      ""
    ].join("\n")
  );
  return projectRoot;
}

function withRuntimeEnvironment(projectRoot: string, run: () => void): void {
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  const previousDisableOv = process.env.RP_DISABLE_OPENVIKING;
  process.env.RP_SQLITE_PATH = join(projectRoot, "state.sqlite");
  process.env.RP_DISABLE_OPENVIKING = "1";
  try {
    run();
  } finally {
    if (previousSqlitePath === undefined) delete process.env.RP_SQLITE_PATH;
    else process.env.RP_SQLITE_PATH = previousSqlitePath;
    if (previousDisableOv === undefined) delete process.env.RP_DISABLE_OPENVIKING;
    else process.env.RP_DISABLE_OPENVIKING = previousDisableOv;
  }
}

test("bootstrap loads world System definitions into shared infrastructure without initializing a save", () => {
  const projectRoot = writeProject();
  try {
    withRuntimeEnvironment(projectRoot, () => {
      const infra = createRuntimeInfrastructure(projectRoot);
      try {
        assert.deepEqual(infra.systemRegistry.names(), ["progression"]);
        assert.equal(infra.systemRegistry.require("progression").version, 2);
        const row = infra.db.prepare("SELECT COUNT(*) AS count FROM system_states").get() as { count: number };
        assert.equal(row.count, 0);
      } finally {
        infra.db.close();
      }
    });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("bootstrap rejects a System whose requested capability has no registered adapter", () => {
  const projectRoot = writeProject({ capabilities: ["rng"] });
  try {
    withRuntimeEnvironment(projectRoot, () => {
      assert.throws(
        () => createRuntimeInfrastructure(projectRoot),
        (error) => error instanceof SystemRuntimeError && error.code === "CAPABILITY_UNAVAILABLE"
      );
    });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("bootstrap exposes one shared System runtime without activating a save", () => {
  const projectRoot = writeProject();
  try {
    withRuntimeEnvironment(projectRoot, () => {
      resetRuntimeInfrastructureForTest();
      try {
        const core = getRuntimeInfrastructure(projectRoot);
        const writer = getRuntimeInfrastructure(projectRoot);
        const memory = getRuntimeInfrastructure(projectRoot);

        assert.equal(typeof core.systemRuntime.commit, "function");
        assert.equal(typeof core.systemRuntime.project, "function");
        assert.equal(core.systemRuntime, writer.systemRuntime);
        assert.equal(core.systemRuntime, memory.systemRuntime);
        const row = core.db
          .prepare("SELECT COUNT(*) AS count FROM system_states")
          .get() as { count: number };
        assert.equal(row.count, 0);
      } finally {
        resetRuntimeInfrastructureForTest();
      }
    });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
