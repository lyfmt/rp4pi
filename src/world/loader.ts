import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  GM_MARKERS,
  HOOK_ANCHORS,
  WRITER_MARKERS,
  type AttributeSpec,
  type HookAction,
  type HookAnchor,
  type HookEvery,
  type HookSpec,
  type HookStateMutation,
  type LoadedWorld,
  type PromptMessageRole,
  type PromptTemplateSpec,
  type PromptTemplates,
  type RevisionConfig,
  type SubagentSpec,
  type WorldInitialState,
  type WorldLoreConfig,
  type WorldMemoryConfig,
  type WritingGuideSpec
} from "./schema.ts";

// The loader is the single seam between a world pack on disk and the runtime.
// It scans `worlds/*/world.yaml`, parses+validates one manifest into a
// normalized `LoadedWorld`, and resolves *which* world is active:
//   RP_WORLD names one → use it; otherwise → the first directory alphabetically.
// Every path in the returned object is absolute, so downstream wiring never has
// to know where the pack lives. Validation is strict and messages name the
// offending field + world, because a silently mis-parsed manifest would surface
// as a confusing runtime failure far from its cause.

export const WORLDS_DIRNAME = "worlds";
export const MANIFEST_FILENAME = "world.yaml";
const MODULE_FIELDS = [
  "state",
  "prompts",
  "prompt_template",
  "memory",
  "lore",
  "tools",
  "subagents",
  "hooks",
  "writing",
  "revision"
] as const;
// The complete set of top-level keys loadWorldFromDir reads. Anything else in
// world.yaml is almost certainly a typo (`writting:` would silently disable a
// whole axis), so unknown keys are a named error, not an ignored no-op.
const TOP_LEVEL_FIELDS: readonly string[] = ["name", "display_name", "description", ...MODULE_FIELDS, "systems"];

export type LoadWorldOptions = {
  /** Override the active world by name; defaults to process.env.RP_WORLD. */
  worldName?: string;
  /** Root that contains the `worlds/` directory; defaults to projectRoot. */
  worldsDir?: string;
};

/** List available world pack names (directories containing a world.yaml). */
export function listWorldNames(projectRoot: string, worldsDir?: string): string[] {
  const base = worldsDir ?? join(projectRoot, WORLDS_DIRNAME);
  if (!existsSync(base)) {
    return [];
  }
  return readdirSync(base)
    .filter((entry) => {
      // `_`-prefixed dirs are templates / disabled packs: they are never listed,
      // so never auto-selected as the default nor runnable by name. Copy one to
      // a real name to use it. (Tests/scaffolding can still call loadWorldFromDir.)
      if (entry.startsWith("_")) {
        return false;
      }
      const manifest = join(base, entry, MANIFEST_FILENAME);
      return statSync(join(base, entry)).isDirectory() && existsSync(manifest);
    })
    .sort();
}

/** Resolve and load the active world pack for this process. */
export function loadActiveWorld(projectRoot: string, options: LoadWorldOptions = {}): LoadedWorld {
  const base = options.worldsDir ?? join(projectRoot, WORLDS_DIRNAME);
  const names = listWorldNames(projectRoot, base);
  if (names.length === 0) {
    throw new Error(`No world packs found under ${base}. Expected at least one <name>/${MANIFEST_FILENAME}.`);
  }

  const requested = options.worldName ?? process.env.RP_WORLD;
  const chosen = requested ?? names[0];
  if (requested && !names.includes(requested)) {
    throw new Error(`World "${requested}" not found. Available: ${names.join(", ")}.`);
  }

  return loadWorldFromDir(join(base, chosen));
}

/** Parse and validate a single world pack directory. Exported for tests. */
export function loadWorldFromDir(worldRoot: string): LoadedWorld {
  try {
    return parseWorldDir(worldRoot);
  } catch (error) {
    // Every load/validation failure names its source pack: manifests are split
    // across module YAMLs, so a bare field path is hard to trace back to a world.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} (while loading world at ${worldRoot})`, { cause: error });
  }
}

function parseWorldDir(worldRoot: string): LoadedWorld {
  const manifestPath = join(worldRoot, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`World manifest missing: ${manifestPath}`);
  }

  const raw = parseYaml(readFileSync(manifestPath, "utf8")) as unknown;
  const rootRecord = asRecord(raw, "world.yaml root");
  assertKnownTopLevelFields(rootRecord);
  const manifest = expandManifestModules(rootRecord, worldRoot);
  const name = requireString(manifest.name, "name");

  const state = asRecord(manifest.state, "state");
  const initialState = parseInitialState(state.initial);
  const attributes = parseAttributes(state.attributes);
  const promptTemplates = parsePromptTemplates(manifest.prompt_template, worldRoot);

  return {
    name,
    displayName: optionalString(manifest.display_name) ?? name,
    description: optionalString(manifest.description) ?? "",
    root: worldRoot,
    initialState,
    attributes,
    gmPromptPaths: parsePromptPaths(manifest.prompts, worldRoot, { gmTemplatePresent: promptTemplates.gm !== undefined }),
    memory: parseMemory(manifest.memory, worldRoot),
    lore: parseLore(manifest.lore, worldRoot),
    tools: parseTools(manifest.tools, worldRoot),
    systemModulePaths: parseSystemModulePaths(manifest.systems, worldRoot),
    subagents: parseSubagents(manifest.subagents, worldRoot),
    hooks: parseHooks(manifest.hooks),
    writingGuides: parseWriting(manifest.writing, worldRoot),
    revision: parseRevision(manifest.revision),
    promptTemplates
  };
}

function assertKnownTopLevelFields(manifest: Record<string, unknown>): void {
  const unknown = Object.keys(manifest).filter((key) => !TOP_LEVEL_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown world.yaml field(s): ${unknown.map((key) => `"${key}"`).join(", ")}. ` +
        `Allowed keys: ${TOP_LEVEL_FIELDS.join(", ")}.`
    );
  }
}

function expandManifestModules(manifest: Record<string, unknown>, worldRoot: string): Record<string, unknown> {
  const expanded = { ...manifest };
  for (const field of MODULE_FIELDS) {
    const value = expanded[field];
    if (typeof value === "string") {
      expanded[field] = readManifestModule(value, field, worldRoot);
    }
  }
  return expanded;
}

function readManifestModule(pathValue: string, field: string, worldRoot: string): unknown {
  if (pathValue.length === 0) {
    throw new Error(`World manifest field "${field}" must reference a non-empty YAML module path.`);
  }
  const modulePath = resolveExistingFile(pathValue, field, worldRoot, "YAML module");
  const parsed = parseYaml(readFileSync(modulePath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`World manifest field "${field}" module ${modulePath} must contain a mapping or list.`);
  }
  return parsed;
}

function parseInitialState(value: unknown): WorldInitialState {
  const initial = asRecord(value, "state.initial");
  const player = asRecord(initial.player, "state.initial.player");
  const time = asRecord(initial.time, "state.initial.time");
  const scene = asRecord(initial.scene, "state.initial.scene");
  return {
    player: {
      name: optionalString(player.name) ?? "",
      status: optionalString(player.status) ?? "",
      location: optionalString(player.location) ?? ""
    },
    time: {
      day: requireInteger(time.day, "state.initial.time.day"),
      hour: requireInteger(time.hour, "state.initial.time.hour")
    },
    scene: { summary: optionalString(scene.summary) ?? "" }
  };
}

function parseAttributes(value: unknown): AttributeSpec[] {
  if (value === undefined || value === null) {
    return [];
  }
  const record = asRecord(value, "state.attributes");
  return Object.entries(record).map(([name, rawSpec]) => {
    const spec = asRecord(rawSpec, `state.attributes.${name}`);
    const type = requireString(spec.type, `state.attributes.${name}.type`);
    const description = optionalString(spec.description);
    if (type === "int") {
      return {
        kind: "int" as const,
        name,
        description,
        min: optionalInteger(spec.min, `state.attributes.${name}.min`),
        max: optionalInteger(spec.max, `state.attributes.${name}.max`),
        initial: requireInteger(spec.initial, `state.attributes.${name}.initial`)
      };
    }
    if (type === "string") {
      return {
        kind: "string" as const,
        name,
        description,
        initial: optionalString(spec.initial) ?? ""
      };
    }
    if (type === "bool") {
      return {
        kind: "bool" as const,
        name,
        description,
        initial: spec.initial === true
      };
    }
    throw new Error(`state.attributes.${name}.type must be int|string|bool, got "${type}".`);
  });
}

function parsePromptPaths(value: unknown, worldRoot: string, options: { gmTemplatePresent?: boolean } = {}): string[] {
  if (value === undefined || value === null) {
    if (options.gmTemplatePresent === true) {
      return [];
    }
    throw new Error("prompts.gm must be a non-empty list of prompt file paths.");
  }
  const prompts = asRecord(value, "prompts");
  const gm = prompts.gm;
  if ((gm === undefined || gm === null) && options.gmTemplatePresent === true) {
    return [];
  }
  if (!Array.isArray(gm) || gm.length === 0) {
    throw new Error("prompts.gm must be a non-empty list of prompt file paths.");
  }
  // A GM prompt is the agent's persona; a typo'd path would otherwise load a
  // world whose GM silently has no instructions. Fail at load, like systems.
  return gm.map((entry, index) => {
    const field = `prompts.gm[${index}]`;
    return resolveExistingFile(requireString(entry, field), field, worldRoot, "prompt file");
  });
}

function parsePromptTemplates(value: unknown, worldRoot: string): PromptTemplates {
  if (value === undefined || value === null) {
    return {};
  }
  const record = asRecord(value, "prompt_template");
  const templates: PromptTemplates = {};
  const gm = parsePromptTemplate(record.gm, "gm", GM_MARKERS, worldRoot);
  const writer = parsePromptTemplate(record.writer, "writer", WRITER_MARKERS, worldRoot);
  if (gm !== undefined) {
    templates.gm = gm;
  }
  if (writer !== undefined) {
    templates.writer = writer;
  }
  return templates;
}

function parsePromptTemplate(
  value: unknown,
  agent: "gm" | "writer",
  allowedMarkers: readonly string[],
  worldRoot: string
): PromptTemplateSpec | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const field = `prompt_template.${agent}`;
  const record = asRecord(value, field);
  const entries = record.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`World manifest field "${field}.entries" must be a non-empty list.`);
  }
  return {
    entries: entries.map((entry, index) =>
      parsePromptTemplateEntry(entry, `${field}.entries[${index}]`, allowedMarkers, worldRoot)
    )
  };
}

function parsePromptTemplateEntry(
  value: unknown,
  field: string,
  allowedMarkers: readonly string[],
  worldRoot: string
): PromptTemplateSpec["entries"][number] {
  const record = asRecord(value, field);
  if (record.marker !== undefined && record.marker !== null) {
    if (record.role !== undefined || record.content !== undefined || record.path !== undefined) {
      throw new Error(`World manifest field "${field}" must be either a marker or a message, not both.`);
    }
    const marker = requireString(record.marker, `${field}.marker`);
    if (!allowedMarkers.includes(marker)) {
      throw new Error(`World manifest field "${field}.marker" must be one of ${allowedMarkers.join(" | ")}; got "${marker}".`);
    }
    return { kind: "marker", marker };
  }

  const role = parsePromptMessageRole(record.role, `${field}.role`);
  const hasContent = record.content !== undefined && record.content !== null;
  const hasPath = record.path !== undefined && record.path !== null;
  if (hasContent === hasPath) {
    throw new Error(`World manifest field "${field}" must provide exactly one of content or path.`);
  }
  if (hasContent) {
    return { kind: "message", role, content: requireString(record.content, `${field}.content`) };
  }

  const path = resolveRelative(requireString(record.path, `${field}.path`), worldRoot);
  try {
    return { kind: "message", role, content: readFileSync(path, "utf8") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`World manifest field "${field}.path" could not be read at ${path}: ${message}`);
  }
}

function parsePromptMessageRole(value: unknown, field: string): PromptMessageRole {
  const role = requireString(value, field);
  if (role === "system" || role === "s") {
    return "system";
  }
  if (role === "assistant" || role === "a") {
    return "assistant";
  }
  if (role === "user" || role === "u") {
    return "user";
  }
  return "user";
}

function parseMemory(value: unknown, worldRoot: string): WorldMemoryConfig {
  const memory = asRecord(value, "memory");
  const policy = asRecord(memory.policy, "memory.policy");
  const self = asRecord(policy.self, "memory.policy.self");
  const peer = asRecord(policy.peer, "memory.policy.peer");
  const memoryTypes = requireStringArray(policy.memory_types, "memory.policy.memory_types");
  const schemas = requireStringArray(memory.schemas, "memory.schemas");
  // A schema file is what OV indexes memories against; a missing one should
  // fail at load with its resolved path, not as a confusing OV error later.
  const schemaPaths = schemas.map((entry, index) =>
    resolveExistingFile(entry, `memory.schemas[${index}]`, worldRoot, "schema file")
  );
  return {
    policy: {
      self: { enabled: self.enabled === true },
      peer: { enabled: peer.enabled === true },
      memory_types: memoryTypes
    },
    schemaPaths,
    schemaDir: deriveSchemaDir(schemaPaths, worldRoot),
    fallbackMemoryTypes: requireStringArray(memory.fallback_memory_types, "memory.fallback_memory_types")
  };
}

function parseLore(value: unknown, worldRoot: string): WorldLoreConfig {
  if (value === undefined || value === null) {
    return { sources: [] };
  }
  const lore = asRecord(value, "lore");
  const sources = lore.sources;
  if (sources === undefined || sources === null) {
    return { sources: [] };
  }
  if (!Array.isArray(sources)) {
    throw new Error(`World manifest field "lore.sources" must be a list.`);
  }
  return {
    sources: sources.map((raw, index) => {
      const source = asRecord(raw, `lore.sources[${index}]`);
      const pathField = `lore.sources[${index}].path`;
      const parsed = {
        // Lore sources are imported into SQLite at startup; a typo'd path must
        // fail here with the field name, not as a distant importer error.
        path: resolveExistingFile(requireString(source.path, pathField), pathField, worldRoot, "lore source file"),
        defaultKind: optionalNonEmptyString(source.default_kind, `lore.sources[${index}].default_kind`)
      };
      return parsed.defaultKind === undefined ? { path: parsed.path } : parsed;
    })
  };
}

function parseTools(value: unknown, worldRoot: string): { include: string[]; extra: string[] } {
  if (value === undefined || value === null) {
    return { include: ["core.state", "core.memory"], extra: [] };
  }
  const tools = asRecord(value, "tools");
  return {
    include: optionalStringArray(tools.include, "tools.include"),
    // Extra tool modules are imported at startup; check existence at load so a
    // typo'd path fails with its field name instead of a runtime import error.
    extra: optionalStringArray(tools.extra, "tools.extra").map((entry, index) =>
      resolveExistingFile(entry, `tools.extra[${index}]`, worldRoot, "tool module")
    )
  };
}

function parseSystemModulePaths(value: unknown, worldRoot: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  return requireStringArray(value, "systems").map((entry, index) =>
    resolveExistingFile(entry, `systems[${index}]`, worldRoot, "System module")
  );
}

// Parse the `subagents:` list into normalized specs. Each entry maps 1:1 onto
// the pi-subagents frontmatter the bootstrap will materialize (S-B): `prompt`
// and `extension` are resolved to absolute paths here (mirroring gmPromptPaths /
// schemaPaths) so downstream materialization never re-resolves. Validation is
// strict — a mis-declared subagent should fail at load, not as a confusing
// spawn error later. `tools` is the least-privilege allowlist; omitting it (or
// giving an empty list) normalizes to a tool-less child rather than inheriting
// pi's full builtin toolset.
function parseSubagents(value: unknown, worldRoot: string): SubagentSpec[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`World manifest field "subagents" must be a list.`);
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const field = (key: string) => `subagents[${index}].${key}`;
    const spec = asRecord(raw, `subagents[${index}]`);

    const name = requireString(spec.name, field("name"));
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(`World manifest field "${field("name")}" must be a slug (letters, digits, "-", "_"); got "${name}".`);
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate subagent name "${name}" in ${field("name")}. Subagent names must be unique within a world.`);
    }
    seen.add(name);

    const tools =
      spec.tools === undefined || spec.tools === null
        ? []
        : requireStringArray(spec.tools, field("tools"));

    const extension = spec.extension;
    return {
      name,
      kind: parseSubagentKind(spec.kind, field("kind")),
      description: requireString(spec.description, field("description")),
      model: optionalNonEmptyString(spec.model, field("model")),
      thinking: optionalNonEmptyString(spec.thinking, field("thinking")),
      tools,
      promptPath: resolveRelative(requireString(spec.prompt, field("prompt")), worldRoot),
      extensionPath:
        extension === undefined || extension === null
          ? undefined
          : resolveRelative(requireString(extension, field("extension")), worldRoot)
    };
  });
}

// A subagent's category. Absent → `tool` (the original ephemeral kind), so
// existing manifests keep working. A present-but-unknown value is a manifest
// error, surfaced by name rather than silently coerced.
function parseSubagentKind(value: unknown, field: string): "tool" | "role" {
  if (value === undefined || value === null) {
    return "tool";
  }
  if (value === "tool" || value === "role") {
    return value;
  }
  throw new Error(`World manifest field "${field}" must be "tool" or "role"; got ${JSON.stringify(value)}.`);
}

// Parse the `hooks:` list into normalized `HookSpec`s. Like subagents, validation
// is strict and names the offending field + index so a mis-declared hook fails at
// load rather than as a confusing no-op at runtime. Each hook is an anchor (`on`)
// + optional cadence gate (`every`) + an action (`do`). The action is a
// discriminated union on `type`; unknown types/anchors are named errors, not
// silent drops.
function parseHooks(value: unknown): HookSpec[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`World manifest field "hooks" must be a list.`);
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const field = (key: string) => `hooks[${index}].${key}`;
    const spec = asRecord(raw, `hooks[${index}]`);

    const name = requireString(spec.name, field("name"));
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(`World manifest field "${field("name")}" must be a slug (letters, digits, "-", "_"); got "${name}".`);
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate hook name "${name}" in ${field("name")}. Hook names must be unique within a world.`);
    }
    seen.add(name);

    return {
      name,
      description: optionalNonEmptyString(spec.description, field("description")),
      on: parseHookAnchor(spec.on, field("on")),
      every: parseHookEvery(spec.every, field("every")),
      action: parseHookAction(spec.do, field("do"))
    };
  });
}

function parseHookAnchor(value: unknown, field: string): HookAnchor {
  const anchor = requireString(value, field);
  if (!HOOK_ANCHORS.includes(anchor as HookAnchor)) {
    throw new Error(`World manifest field "${field}" must be one of ${HOOK_ANCHORS.join(" | ")}; got "${anchor}".`);
  }
  return anchor as HookAnchor;
}

function parseHookEvery(value: unknown, field: string): HookEvery | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = asRecord(value, field);
  const every: HookEvery = {};
  for (const key of ["turns", "gameHours", "gameDays"] as const) {
    if (record[key] !== undefined && record[key] !== null) {
      const n = requireInteger(record[key], `${field}.${key}`);
      if (n <= 0) {
        throw new Error(`World manifest field "${field}.${key}" must be a positive integer; got ${n}.`);
      }
      every[key] = n;
    }
  }
  // An `every:` present but with no recognized gate is a manifest mistake, not a
  // silent "fire always" — say so.
  if (Object.keys(every).length === 0) {
    throw new Error(`World manifest field "${field}" must set at least one of turns / gameHours / gameDays.`);
  }
  return every;
}

function parseHookAction(value: unknown, field: string): HookAction {
  const record = asRecord(value, field);
  const type = requireString(record.type, `${field}.type`);
  if (type === "inject") {
    const as = record.as === undefined || record.as === null ? "prompt" : requireString(record.as, `${field}.as`);
    if (as !== "prompt" && as !== "notice") {
      throw new Error(`World manifest field "${field}.as" must be "prompt" or "notice"; got "${as}".`);
    }
    return { type: "inject", text: requireString(record.text, `${field}.text`), as };
  }
  if (type === "state") {
    return { type: "state", mutations: parseHookMutations(record.mutations, `${field}.mutations`) };
  }
  if (type === "delegate") {
    return {
      type: "delegate",
      subagent: requireString(record.subagent, `${field}.subagent`),
      task: requireString(record.task, `${field}.task`)
    };
  }
  throw new Error(`World manifest field "${field}.type" must be inject | state | delegate; got "${type}".`);
}

function parseHookMutations(value: unknown, field: string): HookStateMutation[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`World manifest field "${field}" must be a non-empty list of state mutations.`);
  }
  return value.map((raw, index) => {
    const itemField = (key: string) => `${field}[${index}].${key}`;
    const mutation = asRecord(raw, `${field}[${index}]`);
    const op = requireString(mutation.op, itemField("op"));
    if (op !== "set" && op !== "add") {
      throw new Error(`World manifest field "${itemField("op")}" must be "set" or "add"; got "${op}".`);
    }
    const rawValue = mutation.value;
    if (typeof rawValue !== "number" && typeof rawValue !== "string" && typeof rawValue !== "boolean") {
      throw new Error(`World manifest field "${itemField("value")}" must be a number, string, or boolean.`);
    }
    if (op === "add" && typeof rawValue !== "number") {
      throw new Error(`World manifest field "${itemField("value")}" must be a number when op is "add".`);
    }
    return { path: requireString(mutation.path, itemField("path")), op, value: rawValue };
  });
}

// Parse the `writing:` list into normalized `WritingGuideSpec`s. Same strict,
// name-the-field validation as subagents/hooks: `kind` is a unique-within-world
// slug (the key `read_writing_guide` takes), `description` is required (it is the
// only thing shown in the writer's guide catalogue), `path` is resolved to an
// absolute path here (like promptPath / schemaPaths) so materialization never
// re-resolves. File existence is NOT checked at load — it is reported when the
// writer actually reads a guide, matching the subagents axis (a persona file's
// existence is likewise deferred), so a world with a typo'd path still loads and
// fails with a clear per-guide read error rather than at boot.
function parseWriting(value: unknown, worldRoot: string): WritingGuideSpec[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`World manifest field "writing" must be a list.`);
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const field = (key: string) => `writing[${index}].${key}`;
    const spec = asRecord(raw, `writing[${index}]`);

    const kind = requireString(spec.kind, field("kind"));
    if (!/^[A-Za-z0-9_-]+$/.test(kind)) {
      throw new Error(`World manifest field "${field("kind")}" must be a slug (letters, digits, "-", "_"); got "${kind}".`);
    }
    if (seen.has(kind)) {
      throw new Error(`Duplicate writing guide kind "${kind}" in ${field("kind")}. Writing guide kinds must be unique within a world.`);
    }
    seen.add(kind);

    return {
      kind,
      description: requireString(spec.description, field("description")),
      path: resolveRelative(requireString(spec.path, field("path")), worldRoot),
      when: optionalNonEmptyString(spec.when, field("when"))
    };
  });
}

// Parse the optional `revision:` section into a normalized `RevisionConfig`.
// Absent ⇒ an empty banned-word list (the base critics still run; the world just
// enforces no world-specific forbidden register). `banned_words`, when present,
// must be a list of non-empty strings — a mis-typed entry is a named error, not a
// silent drop, matching the strictness of the other axes.
function parseRevision(value: unknown): RevisionConfig {
  if (value === undefined || value === null) {
    return { bannedWords: [] };
  }
  const record = asRecord(value, "revision");
  const raw = record.banned_words;
  if (raw === undefined || raw === null) {
    return { bannedWords: [] };
  }
  const bannedWords = requireStringArray(raw, "revision.banned_words");
  bannedWords.forEach((word, index) => {
    if (word.trim().length === 0) {
      throw new Error(`World manifest field "revision.banned_words[${index}]" must be a non-empty string.`);
    }
  });
  return { bannedWords };
}

// All schema files are expected to share one directory (OV's custom_templates_dir
// points at a directory, not individual files). Enforce that so the memory
// config maps cleanly onto OV's model.
function deriveSchemaDir(schemaPaths: string[], worldRoot: string): string {
  if (schemaPaths.length === 0) {
    return join(worldRoot, "memory");
  }
  const dirs = new Set(schemaPaths.map((p) => p.slice(0, p.lastIndexOf("/"))));
  if (dirs.size > 1) {
    throw new Error(`memory.schemas must all live in one directory (OV custom_templates_dir). Got: ${[...dirs].join(", ")}.`);
  }
  return [...dirs][0];
}

function resolveRelative(path: string, worldRoot: string): string {
  return isAbsolute(path) ? path : resolve(worldRoot, path);
}

// Shared "referenced file must exist" check: resolve relative to the world
// root, then require an existing regular file. Every manifest reference the
// runtime will read (module YAMLs, prompts.gm, memory.schemas, systems,
// lore.sources[].path, tools.extra) goes through here so a typo'd path fails
// at load with the field name + resolved path instead of crashing far away at
// runtime. Deliberate exceptions: writing guides and subagent personas defer
// their existence check to the moment they are read (see parseWriting).
function resolveExistingFile(value: string, field: string, worldRoot: string, kind: string): string {
  const path = resolveRelative(value, worldRoot);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`World manifest field "${field}" references missing ${kind}: ${path}.`);
  }
  return path;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`World manifest field "${field}" must be a mapping.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`World manifest field "${field}" must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// Like optionalString, but for optional fields where a present-but-wrong value
// (e.g. `model: 123`) should surface as a named error rather than silently
// vanish. Absent (undefined/null) stays undefined; anything present must be a
// non-empty string.
function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireString(value, field);
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`World manifest field "${field}" must be an integer.`);
  }
  return value;
}

// Like requireInteger, but absent (undefined/null) stays undefined. A present
// non-integer (e.g. `min: "0"`) is a named error rather than a silently dropped
// bound — the attribute would otherwise lose its range check without a peep.
function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireInteger(value, field);
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`World manifest field "${field}" must be a list of strings.`);
  }
  return value as string[];
}

// Like requireStringArray, but absent (undefined/null) normalizes to []. A
// present-but-wrong value (e.g. a bare string) is a named error, not a silent
// empty list — the GM would otherwise lose its whole toolset without a peep.
function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  return requireStringArray(value, field);
}
