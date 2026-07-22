import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Guards the LLM-facing tool contract against regressions of the very bugs
// this refactor fixed. Source: tool-abstraction.md — 入口宽、核心严: no
// additionalProperties:false on LLM-facing schemas; execute arity must match
// real pi `(toolCallId, params, signal, onUpdate, ctx)`; descriptions stay
// scoped to their own tool; every registered tool carries a TUI label.

const modules = await Promise.all([
  import(pathToFileURL(new URL("../../src/tools/state/initialize-new-game.ts", import.meta.url).pathname).href),
  import(pathToFileURL(new URL("../../src/tools/state/update-location.ts", import.meta.url).pathname).href),
  import(pathToFileURL(new URL("../../src/tools/state/update-player-status.ts", import.meta.url).pathname).href),
  import(pathToFileURL(new URL("../../src/tools/state/update-time.ts", import.meta.url).pathname).href),
  import(pathToFileURL(new URL("../../src/tools/state/update-scene.ts", import.meta.url).pathname).href),
  import(pathToFileURL(new URL("../../src/tools/state/get-status.ts", import.meta.url).pathname).href),
  import(pathToFileURL(new URL("../../src/tools/state/commit-turn.ts", import.meta.url).pathname).href),
  import(pathToFileURL(new URL("../../src/tools/state/submit-direction-packet.ts", import.meta.url).pathname).href),
  import(pathToFileURL(new URL("../../src/tools/state/update-attribute.ts", import.meta.url).pathname).href),
  import(pathToFileURL(new URL("../../src/tools/lookup/search-memory.ts", import.meta.url).pathname).href),
  import(pathToFileURL(new URL("../../src/tools/lookup/read-memory.ts", import.meta.url).pathname).href),
  import(pathToFileURL(new URL("../../src/tools/lookup/lookup-lore.ts", import.meta.url).pathname).href),
  import(pathToFileURL(new URL("../../src/tools/lookup/read-lore.ts", import.meta.url).pathname).href)
]);

type ToolModule = {
  name: string;
  label?: string;
  description: string;
  parameters?: Record<string, unknown>;
  execute?: (...args: unknown[]) => unknown;
};

const tools: ToolModule[] = [];
for (const mod of modules) {
  for (const value of Object.values(mod)) {
    if (typeof value === "object" && value !== null && typeof (value as ToolModule).name === "string" && typeof (value as ToolModule).execute === "function") {
      tools.push(value as ToolModule);
    }
  }
}

test("discovered every registered tool", () => {
  assert.equal(tools.length, 13);
});

test("LLM-facing tool schemas allow additional properties (loose entry)", () => {
  for (const tool of tools) {
    assert.equal(tool.parameters?.additionalProperties, undefined, `${tool.name}: schema must not set additionalProperties:false`);
  }
});

test("every tool exposes a named execute boundary (arity is enforced by the static ToolDefinition type)", () => {
  // The headline bug was execute(input, context) reading the wrong argument
  // slots of pi's execute(toolCallId, params, signal, onUpdate, ctx). That arity
  // is now enforced by the ToolDefinition type in src/types/pi.ts; `tsc` rejects
  // any tool that drifts back to the old 2-arg shape. This runtime guard ensures
  // execute is present and named, so accidental rename/loss is caught early.
  for (const tool of tools) {
    assert.equal(typeof tool.execute, "function", `${tool.name}: execute must be a function`);
  }
});

test("model-visible descriptions do not route to other tools", () => {
  for (const tool of tools) {
    const descriptions = collectDescriptions(tool.parameters, [tool.description]).join("\n");
    for (const other of tools) {
      if (other.name !== tool.name) {
        assert.equal(descriptions.includes(other.name), false, `${tool.name}: description must not route to ${other.name}`);
      }
    }
  }
});

test("every tool carries a TUI label", () => {
  for (const tool of tools) {
    assert.equal(typeof tool.label, "string", `${tool.name}: must carry a TUI label`);
  }
});

function collectDescriptions(value: unknown, descriptions: string[]): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectDescriptions(entry, descriptions);
    return descriptions;
  }
  if (typeof value !== "object" || value === null) {
    return descriptions;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "description" && typeof entry === "string") {
      descriptions.push(entry);
    } else {
      collectDescriptions(entry, descriptions);
    }
  }
  return descriptions;
}
