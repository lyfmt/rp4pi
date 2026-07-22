import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContextLike } from "../types/pi.ts";
import { WRITER_SYSTEM_MARKERS, type PromptTemplateSpec } from "../world/schema.ts";
import type { DirectionPacket } from "./direction-packet.ts";
import { emitLiveProgress, type LiveProgressSink, type LiveProgressStage } from "./live-progress.ts";
import {
  buildFullProseMessages,
  buildPlotDigest,
  buildWriterMessages,
  formatPacketForWriter,
  type WriterHistoryItem,
  type WriterMessage
} from "./writer-history.ts";
import { reviseProse, type RevisionModelStage, type RevisionWritingGuide } from "./writer-revision.ts";

export interface WriterClient {
  render(input: WriterRenderInput): Promise<string>;
}

// A read-only tool the writer agent may call inside its loop. `execute` returns
// the model-facing result text; the loop never lets a tool write state. W-B
// builds these by wrapping the existing lookup/status tool definitions with the
// shared bootstrap context; W-C only depends on this minimal shape so the loop
// stays testable with plain fakes.
export type WriterTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
};

// One catalogue entry the writer sees in its system prompt — enough to decide
// whether to pull the full guide via `read_writing_guide` (guidance is read on
// demand, never eagerly injected).
export type WritingGuideCatalogueEntry = { kind: string; description: string };

type WriterModelConfig = {
  provider: string;
  model: string;
  thinking?: string;
};

type WriterRevisionAgentStage = Exclude<RevisionModelStage, "rewrite">;

type WriterModelSettings = {
  writer: WriterModelConfig;
  writerAgents: Partial<Record<WriterRevisionAgentStage, WriterModelConfig>>;
};

type ModelContext = {
  model: unknown;
  auth: { apiKey: string; headers: Record<string, string> | undefined };
};

// A single provider round-trip. Returns the assistant's content parts (text +
// tool calls; thinking is dropped from `parts` but preserved in `raw`) plus the
// raw provider message to replay verbatim on the next step. Injectable so tests
// can drive a scripted multi-step loop; the default calls pi-ai `complete()`.
export type WriterCompletePart =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export type WriterCompletion = {
  parts: WriterCompletePart[];
  raw?: PiAiMessage;
};

type WriterToolSchema = { name: string; description: string; parameters: Record<string, unknown> };

type Complete = (
  model: unknown,
  request: { systemPrompt: string; messages: PiAiMessage[]; tools: WriterToolSchema[] },
  options: {
    apiKey: string;
    headers: Record<string, string> | undefined;
    maxTokens: number;
    sessionId: string;
  }
) => Promise<WriterCompletion>;

type PiAiModel = {
  api?: unknown;
  provider?: unknown;
  id?: unknown;
};

type PiAiMessage =
  | { role: "user"; content: string | Array<{ type: "text"; text: string }>; timestamp: number }
  | {
      role: "assistant";
      content: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
      api: unknown;
      provider: unknown;
      model: string;
      usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        totalTokens: number;
        cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
      };
      stopReason: string;
      timestamp: number;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: Array<{ type: "text"; text: string }>;
      isError: boolean;
      timestamp: number;
    };

export type CreateConfiguredWriterClientInput = {
  projectRoot: string;
  ctx: ExtensionContextLike;
  /** Read-only tools the writer agent may call (W-B supplies the real set). */
  tools?: WriterTool[];
  /** Catalogue of world writing guides, listed in the system prompt so the
   * writer knows what it can pull via `read_writing_guide` (read on demand). */
  writingGuides?: WritingGuideCatalogueEntry[];
  /** Final-draft revision policy + inputs (W-G). When provided, the draft the
   * writer's loop produces passes a mandatory revision pipeline (style enhance →
   * inertia + cliché critics → bounded rewrite) before it becomes the returned
   * prose. Omitting `revision` keeps the plain draft (back-compatible). */
  revision?: WriterRevisionConfig;
  promptTemplate?: PromptTemplateSpec;
  complete?: Complete;
};

export type WriterRenderInput = {
  history: readonly WriterHistoryItem[];
  packet: DirectionPacket;
  progress?: LiveProgressSink;
};

export type WriterRevisionInputs = {
  storyElementsText: string;
  priorProse: string[];
};

export type WriterPromptAssembly = {
  systemPrompt: string;
  messages: WriterMessage[];
  revisionInputs: WriterRevisionInputs;
};

export type WriterPromptAssemblyInput = {
  projectRoot: string;
  writingGuides: readonly WritingGuideCatalogueEntry[];
  history: readonly WriterHistoryItem[];
  packet: DirectionPacket;
  promptTemplate?: PromptTemplateSpec;
};

// What the extension supplies so the revision pipeline can run. `guideBodies`
// resolves each declared writing guide to its full text (the enhancer reads
// bodies, unlike the catalogue which only carries kind+description); a resolver
// that throws for a missing file is simply skipped so revision never fails a turn.
export type WriterRevisionConfig = {
  bannedWords: readonly string[];
  loadGuideBodies?: () => RevisionWritingGuide[];
};

const WRITER_MAX_TOKENS = 16384;

// Hard ceiling on provider round-trips per turn. The writer is an agent (it may
// look up memory / read a guide / check status before writing), so it needs more
// than one step — but a runaway loop would burn tokens without ever producing
// prose. The final allowed step is forced tool-less so it MUST return prose.
const WRITER_MAX_STEPS = 10;

export function assembleWriterPrompt(input: WriterPromptAssemblyInput): WriterPromptAssembly {
  const storyElementsText = formatPacketForWriter(input.packet);
  const priorProseMessages = buildFullProseMessages(input.history);
  const revisionInputs = {
    storyElementsText,
    priorProse: priorProseMessages.map((message) => message.content)
  };

  if (input.promptTemplate === undefined) {
    return {
      systemPrompt: buildWriterSystemPrompt(input.projectRoot, input.writingGuides),
      messages: buildWriterMessages(input.history, input.packet),
      revisionInputs
    };
  }

  const systemSegments: string[] = [];
  const messages: WriterMessage[] = [];
  for (const entry of input.promptTemplate.entries) {
    if (entry.kind === "message") {
      if (entry.role === "system") {
        appendSystemSegment(systemSegments, entry.content);
      } else {
        messages.push({ role: entry.role, content: entry.content });
      }
      continue;
    }

    if (isWriterSystemMarker(entry.marker)) {
      appendSystemSegment(
        systemSegments,
        entry.marker === "writer_base" ? readWriterBase(input.projectRoot) : buildWritingGuidesCatalogue(input.writingGuides)
      );
      continue;
    }

    if (entry.marker === "prior_prose") {
      messages.push(...priorProseMessages);
      continue;
    }
    if (entry.marker === "plot_digest") {
      const digest = buildPlotDigest(input.history);
      if (digest.length > 0) {
        messages.push({ role: "assistant", content: digest });
      }
      continue;
    }
    if (entry.marker === "story_elements") {
      messages.push({ role: "user", content: storyElementsText });
      continue;
    }
    throw new Error(`Unsupported writer prompt marker: ${entry.marker}`);
  }

  return {
    // pi-ai has no mid-conversation system role in its message union, so system
    // entries are deliberately lifted into the single provider systemPrompt.
    systemPrompt: systemSegments.join("\n\n"),
    messages,
    revisionInputs
  };
}

function appendSystemSegment(segments: string[], content: string): void {
  if (content.length > 0) {
    segments.push(content);
  }
}

function isWriterSystemMarker(marker: string): marker is (typeof WRITER_SYSTEM_MARKERS)[number] {
  return WRITER_SYSTEM_MARKERS.includes(marker as (typeof WRITER_SYSTEM_MARKERS)[number]);
}

export function createConfiguredWriterClient(input: CreateConfiguredWriterClientInput): WriterClient {
  const tools = input.tools ?? [];
  const toolSchemas: WriterToolSchema[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));

  return {
    async render(renderInput) {
      const progress = renderInput.progress;
      const settings = readWriterModelSettings(input.projectRoot);
      const config = settings.writer;
      const registry = input.ctx.modelRegistry;
      if (registry === undefined) {
        throw new Error("writer modelRegistry unavailable");
      }

      const writerModelContext = await resolveModelContext(registry, config, "writer");

      const complete = input.complete ?? defaultComplete;
      const assembled = assembleWriterPrompt({
        projectRoot: input.projectRoot,
        writingGuides: input.writingGuides ?? [],
        history: renderInput.history,
        packet: renderInput.packet,
        promptTemplate: input.promptTemplate
      });
      const options = {
        apiKey: writerModelContext.auth.apiKey,
        headers: writerModelContext.auth.headers,
        maxTokens: WRITER_MAX_TOKENS,
        sessionId: `${input.ctx.sessionManager.getSessionId()}:writer`
      };

      const conversation: PiAiMessage[] = assembled.messages.map((message) => toPiAiMessage(message, writerModelContext.model));
      await emitLiveProgress(progress, { type: "stage_start", stage: "draft" });
      let draft: string;
      try {
        let draftCallIndex = 0;
        draft = await produceDraft({
          complete: (model, request, completeOptions) => {
            draftCallIndex += 1;
            return completeWithProgress({
              complete,
              model,
              request,
              options: completeOptions,
              progress,
              stage: "draft",
              callIndex: draftCallIndex
            });
          },
          model: writerModelContext.model,
          systemPrompt: assembled.systemPrompt,
          conversation,
          toolSchemas,
          tools,
          options,
          progress
        });
        await emitLiveProgress(progress, { type: "stage_end", stage: "draft", output: draft });
      } catch (error) {
        await emitLiveProgress(progress, { type: "stage_error", stage: "draft", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }

      if (input.revision === undefined) {
        return draft;
      }

      // A tool-less single-shot adapter over `complete`, for the revision stages
      // (enhancer / critics / rewrite) — each drives a fresh conversation with its
      // own system prompt, no tools, no history replay.
      const revisionContexts = new Map<RevisionModelStage, ModelContext>();
      const sessionId = input.ctx.sessionManager.getSessionId();
      const getRevisionContext = async (stage: RevisionModelStage): Promise<ModelContext> => {
        const cached = revisionContexts.get(stage);
        if (cached !== undefined) {
          return cached;
        }
        const stageConfig = stage === "rewrite" ? config : settings.writerAgents[stage] ?? config;
        const context = stageConfig === config ? writerModelContext : await resolveModelContext(registry, stageConfig, `writerAgents.${stage}`);
        revisionContexts.set(stage, context);
        return context;
      };
      const callModel = async (stage: RevisionModelStage, stageSystemPrompt: string, userContent: string): Promise<string> => {
        await emitLiveProgress(progress, { type: "stage_start", stage });
        const context = await getRevisionContext(stage);
        try {
          const completion = await completeWithProgress({
            complete,
            model: context.model,
            request: { systemPrompt: stageSystemPrompt, messages: [toPiAiMessage({ role: "user", content: userContent }, context.model)], tools: [] },
            options: {
              apiKey: context.auth.apiKey,
              headers: context.auth.headers,
              maxTokens: WRITER_MAX_TOKENS,
              sessionId: `${sessionId}:writer:${stage}`
            },
            progress,
            stage
          });
          const text = stripWriterThinking(joinText(completion.parts));
          await emitLiveProgress(progress, { type: "stage_end", stage, output: text });
          return text;
        } catch (error) {
          await emitLiveProgress(progress, { type: "stage_error", stage, error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      };

      return reviseProse({
        draft,
        storyElements: assembled.revisionInputs.storyElementsText,
        priorProse: assembled.revisionInputs.priorProse,
        bannedWords: input.revision.bannedWords,
        writingGuides: loadGuideBodiesSafely(input.revision),
        callModel
      });
    }
  };
}

// Run the writer's tool-using loop until it converges on prose (or the step cap
// forces a finish). Extracted from render so the revision pipeline (W-G) can wrap
// it: this is the "draft" the critics/enhancer then refine.
async function produceDraft(args: {
  complete: Complete;
  model: unknown;
  systemPrompt: string;
  conversation: PiAiMessage[];
  toolSchemas: WriterToolSchema[];
  tools: readonly WriterTool[];
  options: { apiKey: string; headers: Record<string, string> | undefined; maxTokens: number; sessionId: string };
  progress?: LiveProgressSink;
}): Promise<string> {
  let lastText = "";
  for (let step = 0; step < WRITER_MAX_STEPS; step += 1) {
    // On the final permitted step, withhold tools so the model cannot burn it on
    // another lookup — it must return prose. Also skip tools entirely when the
    // world supplied none (single-step, back-compatible behavior).
    const forceProse = step === WRITER_MAX_STEPS - 1;
    const offeredTools = forceProse ? [] : args.toolSchemas;

    const completion = await args.complete(
      args.model,
      { systemPrompt: args.systemPrompt, messages: args.conversation, tools: offeredTools },
      args.options
    );
    const text = joinText(completion.parts);
    const toolCalls = completion.parts.filter(
      (part): part is Extract<WriterCompletePart, { type: "toolCall" }> => part.type === "toolCall"
    );

    if (toolCalls.length === 0) {
      return extractWriterProse(stripWriterThinking(text));
    }

    // Model wants to look something up: replay its message, then feed each tool
    // result back and loop. `raw` preserves provider-specific fields (e.g. Gemini
    // thoughtSignature); reconstruct only when absent (tests).
    lastText = text;
    args.conversation.push(completion.raw ?? reconstructAssistant(completion.parts, args.model));
    for (const call of toolCalls) {
      await emitLiveProgress(args.progress, { type: "tool_call", stage: "draft", id: call.id, name: call.name, arguments: call.arguments ?? {} });
      const result = await runWriterTool(args.tools, call);
      await emitLiveProgress(args.progress, {
        type: "tool_result",
        stage: "draft",
        id: call.id,
        name: call.name,
        result: toolResultText(result),
        isError: toolResultIsError(result)
      });
      args.conversation.push(result);
    }
  }

  // Loop exhausted without a tool-less finish: fall back to the last text the
  // model produced so the player still sees prose rather than an error.
  return extractWriterProse(stripWriterThinking(lastText));
}

async function completeWithProgress(args: {
  complete: Complete;
  model: unknown;
  request: { systemPrompt: string; messages: PiAiMessage[]; tools: WriterToolSchema[] };
  options: { apiKey: string; headers: Record<string, string> | undefined; maxTokens: number; sessionId: string };
  progress?: LiveProgressSink;
  stage: LiveProgressStage;
  callIndex?: number;
}): Promise<WriterCompletion> {
  await emitLiveProgress(args.progress, {
    type: "model_start",
    stage: args.stage,
    sessionId: args.options.sessionId,
    model: describeModel(args.model),
    callIndex: args.callIndex
  });
  const completion =
    args.complete === defaultComplete
      ? await defaultComplete(args.model, args.request, args.options)
      : await args.complete(args.model, args.request, args.options);
  const toolCallCount = completion.parts.filter((part) => part.type === "toolCall").length;
  await emitLiveProgress(args.progress, {
    type: "model_end",
    stage: args.stage,
    toolCallCount,
    callIndex: args.callIndex
  });
  return completion;
}

// Resolve guide bodies for the enhancer, defensively: a missing/unreadable guide
// must not fail a turn, so a throwing resolver degrades to "no guides" (the
// enhancement stage then simply does not run).
function loadGuideBodiesSafely(revision: WriterRevisionConfig): RevisionWritingGuide[] {
  if (revision.loadGuideBodies === undefined) {
    return [];
  }
  try {
    return revision.loadGuideBodies();
  } catch {
    return [];
  }
}

// Execute one requested tool by name against the read-only set, returning a
// toolResult message. An unknown tool or a thrown error becomes an error result
// fed back to the model (it can recover or write anyway) rather than aborting the
// whole render — the writer must always be able to produce prose.
async function runWriterTool(
  tools: readonly WriterTool[],
  call: Extract<WriterCompletePart, { type: "toolCall" }>
): Promise<PiAiMessage> {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (tool === undefined) {
    return toolResultMessage(call.id, call.name, `Unknown tool: ${call.name}`, true);
  }
  try {
    const result = await tool.execute(call.arguments ?? {});
    return toolResultMessage(call.id, call.name, result, false);
  } catch (error) {
    return toolResultMessage(call.id, call.name, `Tool error: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

function joinText(parts: readonly WriterCompletePart[]): string {
  return parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

function readWriterModelSettings(projectRoot: string): WriterModelSettings {
  const parsed = JSON.parse(readFileSync(join(projectRoot, ".pi", "agent", "settings.json"), "utf8")) as {
    writer?: { provider?: unknown; model?: unknown; thinking?: unknown };
    writerAgents?: {
      styleEnhancer?: { provider?: unknown; model?: unknown; thinking?: unknown };
      inertiaCritic?: { provider?: unknown; model?: unknown; thinking?: unknown };
      clicheCritic?: { provider?: unknown; model?: unknown; thinking?: unknown };
    };
    defaultProvider?: unknown;
    defaultModel?: unknown;
  };
  const provider = parsed.writer?.provider ?? parsed.defaultProvider;
  const model = parsed.writer?.model ?? parsed.defaultModel;
  if (typeof provider !== "string" || provider.length === 0 || typeof model !== "string" || model.length === 0) {
    throw new Error("writer or default provider/model missing in .pi/agent/settings.json");
  }
  const writerBase = { provider, model };
  const writer = {
    provider,
    model: appendThinkingLevel(model, optionalNonEmptyString(parsed.writer?.thinking, "writer.thinking"))
  };
  return {
    writer,
    writerAgents: {
      styleEnhancer: resolveOptionalWriterAgentConfig(parsed.writerAgents?.styleEnhancer, writerBase, "writerAgents.styleEnhancer"),
      inertiaCritic: resolveOptionalWriterAgentConfig(parsed.writerAgents?.inertiaCritic, writerBase, "writerAgents.inertiaCritic"),
      clicheCritic: resolveOptionalWriterAgentConfig(parsed.writerAgents?.clicheCritic, writerBase, "writerAgents.clicheCritic")
    }
  };
}

function resolveOptionalWriterAgentConfig(
  value: { provider?: unknown; model?: unknown; thinking?: unknown } | undefined,
  fallback: WriterModelConfig,
  field: string
): WriterModelConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  const provider = value.provider ?? fallback.provider;
  const model = value.model ?? fallback.model;
  if (typeof provider !== "string" || provider.length === 0 || typeof model !== "string" || model.length === 0) {
    throw new Error(`${field}.provider/model must be non-empty strings in .pi/agent/settings.json`);
  }
  return { provider, model: appendThinkingLevel(model, optionalNonEmptyString(value.thinking, `${field}.thinking`)) };
}

function appendThinkingLevel(model: string, thinking: string | undefined): string {
  return thinking === undefined ? model : `${model}:${thinking}`;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string in .pi/agent/settings.json`);
  }
  return value.trim();
}

async function resolveModelContext(
  registry: NonNullable<ExtensionContextLike["modelRegistry"]>,
  config: WriterModelConfig,
  label: string
): Promise<ModelContext> {
  const model = registry.find(config.provider, config.model);
  if (model === undefined) {
    throw new Error(`${label} model not found: ${config.provider}/${config.model}`);
  }

  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok || auth.apiKey === undefined) {
    throw new Error(`${label} model auth unavailable: ${config.provider}/${config.model}`);
  }
  return { model, auth: { apiKey: auth.apiKey, headers: auth.headers } };
}

// The writer's system prompt is the global `.pi/agents/writer.md` base skeleton
// with the world's writing-guide catalogue appended. Only the catalogue (kind +
// description) is injected — never the guide bodies — so the writer pulls the
// full text on demand via `read_writing_guide` (workflow.md Step_4: 按需读取).
export function readWriterBase(projectRoot: string): string {
  return readFileSync(join(projectRoot, ".pi", "agents", "writer.md"), "utf8").trim();
}

export function buildWritingGuidesCatalogue(guides: readonly WritingGuideCatalogueEntry[]): string {
  if (guides.length === 0) {
    return "";
  }
  return [
    "# 本世界可用的写作指导",
    "",
    "以下写作指导按需取用：判断某类指导与本回合相关时，用 `read_writing_guide` 工具按 `kind` 读取全文，再据其落笔。不要凭猜测代替阅读。",
    "",
    ...guides.map((guide) => `- \`${guide.kind}\`：${guide.description}`)
  ].join("\n");
}

export function buildWriterSystemPrompt(projectRoot: string, guides: readonly WritingGuideCatalogueEntry[]): string {
  const base = readWriterBase(projectRoot);
  const catalogue = buildWritingGuidesCatalogue(guides);
  if (catalogue.length === 0) {
    return base;
  }
  return `${base}\n\n${catalogue}`;
}

async function defaultComplete(
  model: unknown,
  request: { systemPrompt: string; messages: PiAiMessage[]; tools: WriterToolSchema[] },
  options: {
    apiKey: string;
    headers: Record<string, string> | undefined;
    maxTokens: number;
    sessionId: string;
  }
): Promise<WriterCompletion> {
  const { stream } = (await import("@earendil-works/pi-ai")) as {
    stream: (
      model: unknown,
      request: { systemPrompt: string; messages: PiAiMessage[]; tools?: WriterToolSchema[] },
      options: {
        apiKey: string;
        headers: Record<string, string> | undefined;
        maxTokens: number;
        sessionId: string;
      }
    ) => AsyncIterable<{ type: string; delta?: string }> & {
      result(): Promise<{
        content: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
      }>;
    };
  };
  const messageStream = stream(
    model,
    {
      systemPrompt: request.systemPrompt,
      messages: request.messages,
      // Only offer tools when there are any; some providers reject an empty array.
      ...(request.tools.length > 0 ? { tools: request.tools } : {})
    },
    options
  );
  // Drain the stream so `result()` resolves. Per-token deltas are deliberately
  // NOT forwarded to the progress sink: the working-message label is single-line
  // and the raw text (which may include `<thinking>` content) belongs only in
  // the committed writer-prose message.
  for await (const _event of messageStream) {
    void _event;
  }
  const message = await messageStream.result();
  const parts: WriterCompletePart[] = [];
  for (const part of message.content) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
      parts.push({ type: "toolCall", id: part.id, name: part.name, arguments: part.arguments ?? {} });
    }
  }
  return { parts, raw: message as PiAiMessage };
}

function toolResultText(message: PiAiMessage): string {
  if (message.role !== "toolResult") {
    return "";
  }
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function toolResultIsError(message: PiAiMessage): boolean {
  return message.role === "toolResult" && message.isError;
}

function describeModel(model: unknown): string | undefined {
  if (typeof model !== "object" || model === null || Array.isArray(model)) {
    return undefined;
  }
  const typed = model as { provider?: unknown; id?: unknown };
  const provider = typeof typed.provider === "string" ? typed.provider : "";
  const id = typeof typed.id === "string" ? typed.id : "";
  if (provider.length === 0 && id.length === 0) {
    return undefined;
  }
  if (provider.length === 0) {
    return id;
  }
  if (id.length === 0) {
    return provider;
  }
  return `${provider}/${id}`;
}

function toPiAiMessage(message: WriterMessage, model: unknown): PiAiMessage {
  if (message.role !== "assistant") {
    return { role: "user", content: [{ type: "text", text: message.content }], timestamp: 0 };
  }
  return reconstructAssistant([{ type: "text", text: message.content }], model);
}

// Build a pi-ai assistant message from content parts, filling the metadata the
// message shape requires. Used to replay the writer's own tool-calling turn back
// into the conversation when the provider did not hand us a raw message (tests).
function reconstructAssistant(parts: readonly WriterCompletePart[], model: unknown): PiAiMessage {
  const typedModel = model as PiAiModel;
  return {
    role: "assistant",
    content: parts.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "toolCall", id: part.id, name: part.name, arguments: part.arguments }
    ),
    api: typedModel.api,
    provider: typedModel.provider,
    model: typeof typedModel.id === "string" ? typedModel.id : "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "toolUse",
    timestamp: 0
  };
}

function toolResultMessage(toolCallId: string, toolName: string, text: string, isError: boolean): PiAiMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: 0
  };
}

export function stripWriterThinking(text: string): string {
  return text
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<thought\b[^>]*>[\s\S]*?<\/thought>/gi, "")
    .replace(/^\s*<\/(?:think|thinking|thought)>\s*/i, "")
    .trim();
}

export function extractWriterProse(text: string): string {
  let body = text;
  const contentMatch = /<content\b[^>]*>([\s\S]*?)<\/content>/iu.exec(body);
  if (contentMatch?.[1] !== undefined) {
    body = contentMatch[1];
  } else {
    const unclosedMatch = /<content\b[^>]*>([\s\S]*)$/iu.exec(body);
    body = unclosedMatch?.[1] ?? body;
  }
  return body.replace(/^\s*#{1,6}\s*正文\s*\n/iu, "").trim();
}
