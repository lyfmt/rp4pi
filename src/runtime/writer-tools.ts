import { readFileSync } from "node:fs";
import { readMemoryTool } from "../tools/lookup/read-memory.ts";
import { searchMemoryTool } from "../tools/lookup/search-memory.ts";
import { lookupLoreTool } from "../tools/lookup/lookup-lore.ts";
import { readLoreTool } from "../tools/lookup/read-lore.ts";
import { getStatusTool } from "../tools/state/get-status.ts";
import { resultText } from "../tools/runtime/result.ts";
import type { OpenVikingToolContext } from "../ov/search-tools.ts";
import type { StateStore } from "../state/store.ts";
import type { RpDatabase } from "../state/sqlite.ts";
import type { OpenVikingClient } from "../ov/client.ts";
import type { ExtensionContextLike } from "../types/pi.ts";
import type { StateToolContext } from "../tools/state/context.ts";
import type { WritingGuideSpec } from "../world/schema.ts";
import type { SystemRuntimeLifecycle } from "../systems/types.ts";
import type { WriterTool, WritingGuideCatalogueEntry } from "./writer-client.ts";

// The read-only tool surface the writer agent (W-C) may call inside its loop.
// Every tool here is a strict subset of the GM's read-only capabilities — never
// an `update_*` / `initialize_new_game` / `submit_direction_packet`: the writer
// looks things up to write better prose, it never writes state or closes a turn.
//
// The tools share the SAME bootstrap db/stateStore/ovClient as the GM (Pass A),
// so `get_status` / memory lookups see exactly the committed turn the writer is
// rendering. Memory tools are omitted entirely when OV is unreachable (graceful
// degradation, matching the GM side: no OV ⇒ no memory tools registered).
export type WriterToolDeps = {
  db: RpDatabase;
  stateStore: StateStore;
  systemRuntime?: SystemRuntimeLifecycle;
  ovClient: OpenVikingClient | undefined;
  writingGuides: readonly WritingGuideSpec[];
  worldName: string;
};

export function buildWriterTools(deps: WriterToolDeps): WriterTool[] {
  const stateContext: StateToolContext = {
    db: deps.db,
    stateStore: deps.stateStore,
    systemRuntime: deps.systemRuntime,
    projectionAudience: { kind: "writer" },
    worldName: deps.worldName
  };
  const tools: WriterTool[] = [stateTool(getStatusTool, stateContext), stateTool(lookupLoreTool, stateContext), stateTool(readLoreTool, stateContext)];

  if (deps.writingGuides.length > 0) {
    tools.push(readWritingGuideTool(deps.writingGuides));
  }

  // Memory lookups only when OV is configured; otherwise skip (no dead tool the
  // writer would call and always get an error from).
  if (deps.ovClient) {
    const ovContext: OpenVikingToolContext = { db: deps.db, stateStore: deps.stateStore, ovClient: deps.ovClient };
    tools.push(memoryTool(searchMemoryTool, ovContext), memoryTool(readMemoryTool, ovContext));
  }

  return tools;
}

/** The catalogue (kind + description) the writer sees in its system prompt — the
 * bodies stay on disk and are pulled on demand via `read_writing_guide`. */
export function writingGuideCatalogue(guides: readonly WritingGuideSpec[]): WritingGuideCatalogueEntry[] {
  return guides.map((guide) => ({ kind: guide.kind, description: guide.description }));
}

/** Resolve each writing guide to its full body (kind + description + text) for
 * the revision pipeline's style enhancer, which reads bodies rather than the
 * catalogue. Guides whose file cannot be read are skipped, not fatal — revision
 * must never fail a turn over a missing guide. */
export function loadWritingGuideBodies(guides: readonly WritingGuideSpec[]): { kind: string; description: string; body: string }[] {
  const bodies: { kind: string; description: string; body: string }[] = [];
  for (const guide of guides) {
    try {
      bodies.push({ kind: guide.kind, description: guide.description, body: readFileSync(guide.path, "utf8").trim() });
    } catch {
      // Skip an unreadable guide; the enhancer works with whatever resolves.
    }
  }
  return bodies;
}

// Read one world writing guide's full body by `kind`. Existence is checked here
// (deferred from load, per the W-A contract): a typo'd path surfaces as a clear
// per-guide read error the writer can recover from, not a boot failure.
function readWritingGuideTool(guides: readonly WritingGuideSpec[]): WriterTool {
  const byKind = new Map(guides.map((guide) => [guide.kind, guide]));
  const kinds = [...byKind.keys()].join(" | ");
  return {
    name: "read_writing_guide",
    description: `读取本世界某一类写作指导的全文。可用 kind：${kinds}。判断该类指导与本回合相关时调用，再据其落笔。`,
    parameters: {
      type: "object",
      required: ["kind"],
      properties: { kind: { type: "string", description: `写作指导分类，取值之一：${kinds}。` } }
    },
    execute: (args) => {
      const kind = typeof args.kind === "string" ? args.kind : "";
      const guide = byKind.get(kind);
      if (!guide) {
        return `Unknown writing guide kind: "${kind}". Available: ${kinds}.`;
      }
      try {
        return readFileSync(guide.path, "utf8").trim();
      } catch (error) {
        return `Failed to read writing guide "${kind}": ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  };
}

// Wrap an existing OV lookup ToolDefinition as a read-only WriterTool: adapt the
// `(args) => string` writer shape onto pi's `(toolCallId, params, signal,
// onUpdate, ctx)` execute, passing the shared OV domain context in the ctx slot
// (exactly how the registry binds these tools for the GM).
function memoryTool(
  tool: typeof searchMemoryTool | typeof readMemoryTool,
  ovContext: OpenVikingToolContext
): WriterTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (args) => {
      const result = await tool.execute(tool.name, args, undefined, undefined, ovContext as unknown as ExtensionContextLike);
      return resultText(result);
    }
  };
}

function stateTool(
  tool: typeof getStatusTool | typeof lookupLoreTool | typeof readLoreTool,
  stateContext: StateToolContext
): WriterTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (args) => {
      const result = await tool.execute(tool.name, args, undefined, undefined, stateContext as unknown as ExtensionContextLike);
      return resultText(result);
    }
  };
}
