import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LoadedWorld, SubagentSpec } from "./schema.ts";
import { applySubagentSettings, readSubagentSettings } from "./subagent-settings.ts";

// S-B: materialize a world's declared subagents (S-A `SubagentSpec`s) into
// `<projectRoot>/.pi/agents/<name>.md`, the directory pi-subagents scans for
// project agents (getProjectConfigDir = `.pi`). The world pack stays the single
// source of truth; these files are a generated projection of it, rewritten on
// every startup so edits to world.yaml / agent.md take effect on the next run.
//
// Discipline this enforces: each subagent's `tools` becomes pi-subagents'
// `--tools` allowlist (least privilege) and `extension` becomes
// `subagentOnlyExtensions` (world-specific tools loaded ONLY inside the spawned
// child, never on the GM's own tool surface). Fixed-lore tools follow the same
// rule: a subagent sees `lookup` / `read_lore` only when its spec explicitly
// lists them in `tools`.

/** Frontmatter marker identifying a file this loader generated. Hand-authored
 * agents (e.g. `.pi/agents/writer.md`) lack it and are never touched. It sits on
 * a comment line inside the frontmatter block, which pi-subagents' parser
 * ignores (it only reads `key: value` lines). */
export const RP_SUBAGENT_MARKER = "@rp-world-subagent";

// A second marker carried ONLY by GM-forged dynamic-role files. Both markers
// share the generated-file cleanup (RP_SUBAGENT_MARKER), but the dynamic
// materializer keys its own scoped cleanup on this one so it can rewrite the
// active save's forged roles without touching the world's static agents.
export const RP_DYNAMIC_ROLE_MARKER = "@rp-dynamic-role";

// The base-platform extension every `kind: role` subagent gets auto-attached
// (relative to projectRoot). It registers recall_self / remember_action so a
// world author writes only a persona — the trajectory machinery is not the
// world's to re-declare. Path, not import: it becomes the child's
// subagentOnlyExtensions entry, loaded ONLY inside the spawned role process.
export const ROLE_RUNTIME_EXTENSION_RELATIVE = "src/subagents/role-runtime.ts";

/** The two tools role-runtime.ts registers, always added to a role's allowlist. */
export const ROLE_RUNTIME_TOOLS = ["recall_self", "remember_action"] as const;

// Sentinel allowlist for a tool-less subagent. pi-subagents only emits `--tools`
// when the allowlist is non-empty, and an omitted allowlist makes pi inherit its
// FULL builtin toolset — the opposite of "no tools". pi, however, documents that
// unknown tool names in `--tools` are ignored, so a reserved name that matches
// no registered tool resolves to zero enabled tools. That is how a world's
// empty `tools` becomes a genuinely tool-less child.
export const NO_TOOLS_SENTINEL = "__rp_no_tools__";

/**
 * Rewrite `<projectRoot>/.pi/agents/` to match `world.subagents`:
 * remove previously-generated files (so removed/renamed subagents and world
 * switches never leave stale agents discoverable), then write the current set.
 * Returns the absolute paths written. Hand-authored files are preserved and
 * never overwritten.
 */
export function materializeWorldSubagents(projectRoot: string, world: LoadedWorld): string[] {
  const dir = join(projectRoot, ".pi", "agents");
  mkdirSync(dir, { recursive: true });

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const path = join(dir, entry);
    if (isGeneratedSubagentFile(path)) {
      rmSync(path, { force: true });
    }
  }

  const written: string[] = [];
  const subagentSettings = readSubagentSettings(projectRoot);
  for (const spec of world.subagents) {
    const file = join(dir, `${spec.name}.md`);
    // Cleanup already removed our own files, so anything still here is
    // hand-authored — refuse to clobber it (protects writer.md and friends).
    if (existsSync(file) && !isGeneratedSubagentFile(file)) {
      throw new Error(
        `Subagent "${spec.name}" would overwrite a hand-authored .pi/agents/${spec.name}.md. Rename the subagent or remove that file.`
      );
    }
    const effectiveSpec = applySubagentSettings(spec, subagentSettings[spec.name]);
    writeFileSync(file, renderSubagentMarkdown(effectiveSpec, world.name, projectRoot), "utf8");
    written.push(file);
  }
  return written;
}

/** Render one spec as a pi-subagents agent file: frontmatter + persona body.
 * `projectRoot` is required to resolve the base role-runtime extension for
 * `kind: role` subagents; it is unused for `kind: tool`. */
export function renderSubagentMarkdown(spec: SubagentSpec, worldName: string, projectRoot?: string): string {
  return renderAgentMarkdown({
    name: spec.name,
    kind: spec.kind,
    description: spec.description,
    model: spec.model,
    thinking: spec.thinking,
    tools: spec.tools,
    worldExtensionPath: spec.extensionPath,
    persona: readPersona(spec),
    projectRoot,
    markerNote: `${RP_SUBAGENT_MARKER} — generated from worlds/${worldName}. Edits are overwritten at startup.`
  });
}

/** The shared frontmatter+body renderer behind both the world-static and the
 * GM-forged (dynamic) materializers. Persona arrives as text (a file for static
 * specs, a db string for forged roles), and `markerNote` carries whichever
 * marker keys that path's cleanup. */
export function renderAgentMarkdown(input: {
  name: string;
  kind: "tool" | "role";
  description: string;
  model?: string;
  thinking?: string;
  tools: string[];
  worldExtensionPath?: string;
  persona: string;
  projectRoot?: string;
  markerNote: string;
}): string {
  const isRole = input.kind === "role";

  // A role subagent gets the base recall/remember tools folded into its
  // allowlist and the base role-runtime extension folded into its child-only
  // extensions, so neither a world nor a forge call declares them. Merge without
  // duplicating whatever may already be listed.
  const tools = isRole ? mergeUnique(input.tools, ROLE_RUNTIME_TOOLS) : input.tools;
  const extensions = [...(input.worldExtensionPath !== undefined ? [input.worldExtensionPath] : [])];
  if (isRole) {
    if (input.projectRoot === undefined) {
      throw new Error(`Rendering role subagent "${input.name}" requires projectRoot to resolve the role-runtime extension.`);
    }
    extensions.push(join(input.projectRoot, ROLE_RUNTIME_EXTENSION_RELATIVE));
  }

  const lines: string[] = ["---"];
  lines.push(`# ${input.markerNote}`);
  lines.push(`name: ${input.name}`);
  lines.push(`description: ${collapse(input.description)}`);
  if (input.model !== undefined) {
    lines.push(`model: ${input.model}`);
  }
  if (input.thinking !== undefined) {
    lines.push(`thinking: ${input.thinking}`);
  }
  // A declared allowlist is the least-privilege set; an empty one means a
  // genuinely tool-less child, encoded via the sentinel (see NO_TOOLS_SENTINEL).
  // (A role always has at least recall_self/remember_action, so it is never the
  // sentinel case.)
  if (tools.length > 0) {
    lines.push(`tools: ${tools.join(", ")}`);
  } else {
    lines.push("# no tools declared — sentinel resolves to zero enabled tools (pi ignores unknown tool names)");
    lines.push(`tools: ${NO_TOOLS_SENTINEL}`);
  }
  if (extensions.length > 0) {
    lines.push(`subagentOnlyExtensions: ${extensions.join(", ")}`);
  }
  // Lock the narrow defaults explicitly so behavior is stable across
  // pi-subagents versions: a clean system prompt, no inherited project
  // instructions, no inherited skills catalog.
  lines.push("systemPromptMode: replace");
  lines.push("inheritProjectContext: false");
  lines.push("inheritSkills: false");
  lines.push("---");
  lines.push("");
  return `${lines.join("\n")}\n${input.persona.trim()}\n`;
}

function readPersona(spec: SubagentSpec): string {
  try {
    return readFileSync(spec.promptPath, "utf8");
  } catch {
    throw new Error(`Subagent "${spec.name}" persona file is missing or unreadable: ${spec.promptPath}`);
  }
}

function isGeneratedSubagentFile(path: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(RP_SUBAGENT_MARKER);
  } catch {
    return false;
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Append `extra` items not already in `base`, preserving order. */
function mergeUnique(base: readonly string[], extra: readonly string[]): string[] {
  const merged = [...base];
  for (const item of extra) {
    if (!merged.includes(item)) {
      merged.push(item);
    }
  }
  return merged;
}
