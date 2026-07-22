import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadWorldFromDir } from "../../src/world/loader.ts";

// H-A: the declarative `hooks:` axis. A world declares hooks (anchor + optional
// cadence gate + action); the loader normalizes and strictly validates them,
// mirroring the subagents axis. These tests pin the contract the runtime engine
// (H-B) then consumes.

test("parses an inject hook with defaults", () => {
  const world = withHooks([
    "hooks:",
    "  - name: dawn-note",
    "    description: A gentle nudge each turn.",
    "    on: turn_start",
    "    do:",
    "      type: inject",
    "      text: 雾气仍未散去。"
  ]);
  assert.equal(world.hooks.length, 1);
  const hook = world.hooks[0];
  assert.equal(hook.name, "dawn-note");
  assert.equal(hook.description, "A gentle nudge each turn.");
  assert.equal(hook.on, "turn_start");
  assert.equal(hook.every, undefined);
  assert.equal(hook.action.type, "inject");
  if (hook.action.type === "inject") {
    assert.equal(hook.action.text, "雾气仍未散去。");
    assert.equal(hook.action.as, "prompt");
  }
});

test("inject hook honours an explicit `as: notice`", () => {
  const hook = withHooks([
    "hooks:",
    "  - name: n",
    "    on: turn_committed",
    "    do: { type: inject, text: 时辰已晚, as: notice }"
  ]).hooks[0];
  assert.equal(hook.action.type, "inject");
  if (hook.action.type === "inject") {
    assert.equal(hook.action.as, "notice");
  }
});

test("parses a cadence gate (every) with multiple units", () => {
  const hook = withHooks([
    "hooks:",
    "  - name: rest",
    "    on: turn_committed",
    "    every: { turns: 3, gameHours: 6 }",
    "    do: { type: inject, text: 休整片刻 }"
  ]).hooks[0];
  assert.deepEqual(hook.every, { turns: 3, gameHours: 6 });
});

test("parses a state hook with set and add mutations", () => {
  const hook = withHooks([
    "hooks:",
    "  - name: drift",
    "    on: turn_committed",
    "    do:",
    "      type: state",
    "      mutations:",
    "        - { path: attributes.vigor, op: add, value: -2 }",
    "        - { path: time.hour, op: set, value: 12 }"
  ]).hooks[0];
  assert.equal(hook.action.type, "state");
  if (hook.action.type === "state") {
    assert.deepEqual(hook.action.mutations, [
      { path: "attributes.vigor", op: "add", value: -2 },
      { path: "time.hour", op: "set", value: 12 }
    ]);
  }
});

test("parses a delegate hook", () => {
  const hook = withHooks([
    "hooks:",
    "  - name: offscreen",
    "    on: turn_committed",
    "    every: { turns: 4 }",
    "    do: { type: delegate, subagent: event-scout, task: 生成一个后台事件候选 }"
  ]).hooks[0];
  assert.equal(hook.action.type, "delegate");
  if (hook.action.type === "delegate") {
    assert.equal(hook.action.subagent, "event-scout");
    assert.equal(hook.action.task, "生成一个后台事件候选");
  }
});

test("missing hooks section normalizes to []", () => {
  assert.deepEqual(withHooks([]).hooks, []);
});

test("unknown anchor is rejected", () => {
  assert.throws(
    () => withHooks(["hooks:", "  - name: h", "    on: midnight", "    do: { type: inject, text: x }"]),
    /hooks\[0\]\.on.*session_start/s
  );
});

test("unknown action type is rejected", () => {
  assert.throws(
    () => withHooks(["hooks:", "  - name: h", "    on: turn_start", "    do: { type: teleport }"]),
    /hooks\[0\]\.do\.type.*inject.*state.*delegate/s
  );
});

test("duplicate hook names are rejected", () => {
  assert.throws(
    () =>
      withHooks([
        "hooks:",
        "  - name: dup",
        "    on: turn_start",
        "    do: { type: inject, text: a }",
        "  - name: dup",
        "    on: turn_start",
        "    do: { type: inject, text: b }"
      ]),
    /Duplicate hook name "dup"/
  );
});

test("hook name must be a slug", () => {
  assert.throws(
    () => withHooks(["hooks:", "  - name: bad name!", "    on: turn_start", "    do: { type: inject, text: a }"]),
    /must be a slug/
  );
});

test("an empty every gate is rejected", () => {
  assert.throws(
    () => withHooks(["hooks:", "  - name: h", "    on: turn_start", "    every: {}", "    do: { type: inject, text: a }"]),
    /must set at least one of turns/
  );
});

test("a non-positive every gate is rejected", () => {
  assert.throws(
    () =>
      withHooks(["hooks:", "  - name: h", "    on: turn_start", "    every: { turns: 0 }", "    do: { type: inject, text: a }"]),
    /must be a positive integer/
  );
});

test("state hook requires a non-empty mutations list", () => {
  assert.throws(
    () => withHooks(["hooks:", "  - name: h", "    on: turn_committed", "    do: { type: state, mutations: [] }"]),
    /mutations.*non-empty/s
  );
});

test("op: add with a non-numeric value is rejected", () => {
  assert.throws(
    () =>
      withHooks([
        "hooks:",
        "  - name: h",
        "    on: turn_committed",
        "    do: { type: state, mutations: [ { path: player.status, op: add, value: hurt } ] }"
      ]),
    /must be a number when op is "add"/
  );
});

test("inject hook missing text is rejected", () => {
  assert.throws(
    () => withHooks(["hooks:", "  - name: h", "    on: turn_start", "    do: { type: inject }"]),
    /hooks\[0\]\.do\.text/
  );
});

// Write a minimal valid world with a caller-supplied `hooks:` block and load it.
function withHooks(hooksYaml: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "worlds-hooks-"));
  const root = join(dir, "w");
  mkdirSync(join(root, "memory"), { recursive: true });
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "prompts", "gm.md"), "# GM\n");
  writeFileSync(join(root, "memory", "characters.yaml"), "memory_type: characters\n");
  writeFileSync(
    join(root, "world.yaml"),
    [
      "name: w",
      "state:",
      "  initial:",
      "    player: { name: \"\", status: ok, location: here }",
      "    time: { day: 1, hour: 8 }",
      "    scene: { summary: start }",
      "prompts:",
      "  gm: [ ./prompts/gm.md ]",
      "memory:",
      "  policy:",
      "    self: { enabled: true }",
      "    peer: { enabled: false }",
      "    memory_types: [ characters ]",
      "  schemas: [ ./memory/characters.yaml ]",
      "  fallback_memory_types: [ entities ]",
      ...hooksYaml,
      ""
    ].join("\n")
  );
  try {
    return loadWorldFromDir(root);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
