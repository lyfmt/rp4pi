import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { parseDirectionPacket, type DirectionPacket } from "../../src/runtime/direction-packet.ts";
import { formatPacketForWriter, type WriterHistoryItem } from "../../src/runtime/writer-history.ts";
import type { PromptTemplateSpec } from "../../src/world/schema.ts";

const writerClient = await import(pathToFileURL(new URL("../../src/runtime/writer-client.ts", import.meta.url).pathname).href);

const createConfiguredWriterClient =
  writerClient.createConfiguredWriterClient as typeof import("../../src/runtime/writer-client.js").createConfiguredWriterClient;

type Completion = import("../../src/runtime/writer-client.js").WriterCompletion;
type WriterTool = import("../../src/runtime/writer-client.js").WriterTool;
type LiveProgressEvent = { type: string; stage?: string; name?: string };

// A minimal world root with a writer.md skeleton and a writer model configured.
function scaffoldRoot(prefix: string, writerMd = "# Writer\n只返回正文。"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".pi", "agent"), { recursive: true });
  mkdirSync(join(root, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "agent", "settings.json"),
    JSON.stringify({ writer: { provider: "opencode-go", model: "deepseek-v4-pro" } })
  );
  writeFileSync(join(root, ".pi", "agents", "writer.md"), writerMd);
  return root;
}

const fakeCtx = {
  sessionManager: { getSessionId: () => "session-1" },
  modelRegistry: {
    find(provider: string, modelId: string) {
      return provider === "opencode-go" && modelId === "deepseek-v4-pro"
        ? { provider, id: modelId, api: "openai-completions" }
        : undefined;
    },
    async getApiKeyAndHeaders() {
      return { ok: true, apiKey: "test-key", headers: { "x-test": "1" } };
    }
  }
} as const;

function storyPacket(currentSituation = "Plot"): DirectionPacket {
  return parseDirectionPacket({
    storyElements: {
      currentSituation,
      playerIntent: "The player continues.",
      visibleChanges: ["The scene changes."],
      presentCharacters: ["player"],
      characterActions: [],
      tension: "The situation remains unresolved."
    },
    needsRender: true,
    directReply: ""
  });
}

function renderInput(currentSituation = "Plot", history: WriterHistoryItem[] = []) {
  return { history, packet: storyPacket(currentSituation) };
}

test("configured writer client calls the configured pi model and returns cleaned prose", async () => {
  const root = scaffoldRoot("rp-writer-client-");
  try {
    const calls: unknown[] = [];
    const client = createConfiguredWriterClient({
      projectRoot: root,
      ctx: fakeCtx,
      complete: async (model, request, options): Promise<Completion> => {
        calls.push({ model, request, options });
        return { parts: [{ type: "text", text: "<think>草稿</think>\n<content>\nRendered prose.\n</content>" }] };
      }
    });

    const packet = storyPacket("Plot: courier arrives");
    const prose = await client.render({ history: [], packet });

    assert.equal(prose, "Rendered prose.");
    assert.equal(calls.length, 1);
    const call = calls[0] as { model: unknown; request: { systemPrompt: string; messages: unknown[]; tools: unknown[] }; options: unknown };
    assert.deepEqual(call.model, { provider: "opencode-go", id: "deepseek-v4-pro", api: "openai-completions" });
    assert.equal(call.request.systemPrompt, "# Writer\n只返回正文。");
    assert.deepEqual(call.request.messages, [{ role: "user", content: [{ type: "text", text: formatPacketForWriter(packet) }], timestamp: 0 }]);
    assert.deepEqual(call.request.tools, []);
    assert.deepEqual(call.options, {
      apiKey: "test-key",
      headers: { "x-test": "1" },
      maxTokens: 16384,
      sessionId: "session-1:writer"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured writer client falls back to the default model when writer config is absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-writer-client-default-"));
  try {
    mkdirSync(join(root, ".pi", "agent"), { recursive: true });
    mkdirSync(join(root, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "agent", "settings.json"),
      JSON.stringify({ defaultProvider: "opencode-go", defaultModel: "deepseek-v4-pro" })
    );
    writeFileSync(join(root, ".pi", "agents", "writer.md"), "# Writer\n只返回正文。");

    const client = createConfiguredWriterClient({
      projectRoot: root,
      ctx: {
        sessionManager: { getSessionId: () => "session-1" },
        modelRegistry: {
          find(provider: string, modelId: string) {
            return provider === "opencode-go" && modelId === "deepseek-v4-pro"
              ? { provider, id: modelId, api: "openai-completions" }
              : undefined;
          },
          async getApiKeyAndHeaders() {
            return { ok: true, apiKey: "test-key" };
          }
        }
      },
      complete: async (): Promise<Completion> => ({ parts: [{ type: "text", text: "<content>Rendered with default model.</content>" }] })
    });

    assert.equal(await client.render(renderInput("Plot")), "Rendered with default model.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writer agent loop dispatches a requested tool, feeds the result back, then converges on prose", async () => {
  const root = scaffoldRoot("rp-writer-loop-");
  try {
    const toolCalls: Record<string, unknown>[] = [];
    const guideTool: WriterTool = {
      name: "read_writing_guide",
      description: "读取写作指导",
      parameters: { type: "object", properties: { kind: { type: "string" } } },
      execute: (args) => {
        toolCalls.push(args);
        return "指导：多用感官细节。";
      }
    };

    const seenMessages: unknown[][] = [];
    let step = 0;
    const client = createConfiguredWriterClient({
      projectRoot: root,
      ctx: fakeCtx,
      tools: [guideTool],
      complete: async (_model, request): Promise<Completion> => {
        seenMessages.push(request.messages);
        step += 1;
        if (step === 1) {
          // First: offered the tool, request it.
          assert.deepEqual(request.tools, [
            { name: "read_writing_guide", description: "读取写作指导", parameters: { type: "object", properties: { kind: { type: "string" } } } }
          ]);
          return { parts: [{ type: "toolCall", id: "call-1", name: "read_writing_guide", arguments: { kind: "style" } }] };
        }
        // Second: the tool result is now in the conversation; write prose.
        return { parts: [{ type: "text", text: "<content>感官充盈的正文。</content>" }] };
      }
    });

    const prose = await client.render(renderInput("# Story Elements\n..."));

    assert.equal(prose, "感官充盈的正文。");
    assert.equal(step, 2);
    assert.deepEqual(toolCalls, [{ kind: "style" }]);
    // On the second call the conversation must contain the assistant tool-call
    // turn and the tool result fed back to the model.
    const secondMessages = seenMessages[1] as Array<{ role: string; toolCallId?: string; content: unknown }>;
    const toolResult = secondMessages.find((m) => m.role === "toolResult");
    assert.ok(toolResult, "tool result must be fed back into the conversation");
    assert.equal(toolResult?.toolCallId, "call-1");
    assert.deepEqual(toolResult?.content, [{ type: "text", text: "指导：多用感官细节。" }]);
    assert.ok(secondMessages.some((m) => m.role === "assistant"), "the writer's tool-calling turn must be replayed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured writer client emits live progress for draft tools and revision agents", async () => {
  const root = scaffoldRoot("rp-writer-progress-");
  try {
    const events: LiveProgressEvent[] = [];
    const guideTool: WriterTool = {
      name: "read_writing_guide",
      description: "读取写作指导",
      parameters: { type: "object", properties: { kind: { type: "string" } } },
      execute: () => "指导：多用感官细节。"
    };

    let draftCalls = 0;
    const client = createConfiguredWriterClient({
      projectRoot: root,
      ctx: fakeCtx,
      tools: [guideTool],
      revision: {
        bannedWords: ["忽然"],
        loadGuideBodies: () => [{ kind: "style", description: "风格", body: "多用感官。" }]
      },
      complete: async (_model, request): Promise<Completion> => {
        if (/^# Writer/.test(request.systemPrompt)) {
          draftCalls += 1;
          return draftCalls === 1
            ? { parts: [{ type: "toolCall", id: "guide-1", name: "read_writing_guide", arguments: { kind: "style" } }] }
            : { parts: [{ type: "text", text: "<content>初稿正文。</content>" }] };
        }
        if (/文风顾问/.test(request.systemPrompt)) {
          return { parts: [{ type: "text", text: "增加触觉。" }] };
        }
        if (/执笔者。/.test(request.systemPrompt)) {
          return { parts: [{ type: "text", text: "<content>增强后的正文。</content>" }] };
        }
        return { parts: [{ type: "text", text: "PASS" }] };
      }
    });

    const prose = await client.render({
      ...renderInput("当前要素"),
      progress: (event) => {
        events.push(event);
      }
    });

    assert.equal(prose, "增强后的正文。");
    assert.ok(events.some((event) => event.type === "stage_start" && event.stage === "draft"), "draft stage must start visibly");
    assert.ok(
      events.some((event) => event.type === "tool_call" && event.stage === "draft" && event.name === "read_writing_guide"),
      "writer read-only tool call must be visible"
    );
    assert.ok(
      events.some((event) => event.type === "tool_result" && event.stage === "draft" && event.name === "read_writing_guide"),
      "writer read-only tool result must be visible"
    );
    for (const stage of ["styleEnhancer", "inertiaCritic", "clicheCritic", "rewrite"] as const) {
      assert.ok(events.some((event) => event.type === "stage_start" && event.stage === stage), `${stage} must start visibly`);
      assert.ok(events.some((event) => event.type === "stage_end" && event.stage === stage), `${stage} must finish visibly`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writer agent loop falls back to the last text when it never stops calling tools", async () => {
  const root = scaffoldRoot("rp-writer-maxstep-");
  try {
    let lastOfferedTools: unknown[] = [];
    const loopingTool: WriterTool = {
      name: "get_status",
      description: "读取状态",
      parameters: { type: "object", properties: {} },
      execute: () => "状态：清醒"
    };

    let step = 0;
    const client = createConfiguredWriterClient({
      projectRoot: root,
      ctx: fakeCtx,
      tools: [loopingTool],
      complete: async (_model, request): Promise<Completion> => {
        step += 1;
        lastOfferedTools = request.tools;
        // Keep requesting a tool every step (also emit some text so the fallback
        // has something to salvage), never a clean prose finish...
        return {
          parts: [
            { type: "text", text: "<content>兜底正文。</content>" },
            { type: "toolCall", id: `call-${step}`, name: "get_status", arguments: {} }
          ]
        };
      }
    });

    const prose = await client.render(renderInput("..."));

    // ...the loop is bounded and the last text is salvaged as prose.
    assert.equal(prose, "兜底正文。");
    assert.equal(step, 10, "loop must be capped at WRITER_MAX_STEPS");
    // The final permitted step withholds tools so the model is forced toward prose.
    assert.deepEqual(lastOfferedTools, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writer agent loop tolerates an unknown tool and a throwing tool without aborting the render", async () => {
  const root = scaffoldRoot("rp-writer-toolerr-");
  try {
    const throwingTool: WriterTool = {
      name: "search_memory",
      description: "检索记忆",
      parameters: { type: "object", properties: {} },
      execute: () => {
        throw new Error("OV unreachable");
      }
    };

    let results: Array<{ toolCallId: string; content: unknown; isError: boolean }> = [];
    let step = 0;
    const client = createConfiguredWriterClient({
      projectRoot: root,
      ctx: fakeCtx,
      tools: [throwingTool],
      complete: async (_model, request): Promise<Completion> => {
        // Snapshot the tool results present in *this* conversation (the loop
        // accumulates messages, so the last call sees the full set).
        results = (request.messages as Array<{ role: string; toolCallId?: string; content: unknown; isError?: boolean }>)
          .filter((m) => m.role === "toolResult")
          .map((m) => ({ toolCallId: m.toolCallId ?? "", content: m.content, isError: m.isError ?? false }));
        step += 1;
        if (step === 1) {
          return { parts: [{ type: "toolCall", id: "u1", name: "no_such_tool", arguments: {} }] };
        }
        if (step === 2) {
          return { parts: [{ type: "toolCall", id: "e1", name: "search_memory", arguments: {} }] };
        }
        return { parts: [{ type: "text", text: "<content>依然产出正文。</content>" }] };
      }
    });

    const prose = await client.render(renderInput("..."));

    assert.equal(prose, "依然产出正文。");
    // Both the unknown-tool and the thrown-error surface as error tool results.
    assert.equal(results.length, 2);
    assert.equal(results[0].isError, true);
    assert.deepEqual(results[0].content, [{ type: "text", text: "Unknown tool: no_such_tool" }]);
    assert.equal(results[1].isError, true);
    assert.match((results[1].content as Array<{ text: string }>)[0].text, /OV unreachable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writing guide catalogue is appended to the writer system prompt, guide bodies are not", async () => {
  const root = scaffoldRoot("rp-writer-catalogue-");
  try {
    let seenSystemPrompt = "";
    const client = createConfiguredWriterClient({
      projectRoot: root,
      ctx: fakeCtx,
      writingGuides: [
        { kind: "style", description: "叙事语气与节奏。" },
        { kind: "adult", description: "成人场景指导。" }
      ],
      complete: async (_model, request): Promise<Completion> => {
        seenSystemPrompt = request.systemPrompt;
        return { parts: [{ type: "text", text: "<content>正文。</content>" }] };
      }
    });

    await client.render(renderInput("..."));

    assert.match(seenSystemPrompt, /# 本世界可用的写作指导/);
    assert.match(seenSystemPrompt, /`style`：叙事语气与节奏。/);
    assert.match(seenSystemPrompt, /`adult`：成人场景指导。/);
    assert.match(seenSystemPrompt, /read_writing_guide/);
    // The base skeleton is preserved and the catalogue is appended after it.
    assert.match(seenSystemPrompt, /^# Writer\n只返回正文。/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no writing guides leaves the writer system prompt as the bare skeleton", async () => {
  const root = scaffoldRoot("rp-writer-noguide-");
  try {
    let seenSystemPrompt = "";
    const client = createConfiguredWriterClient({
      projectRoot: root,
      ctx: fakeCtx,
      complete: async (_model, request): Promise<Completion> => {
        seenSystemPrompt = request.systemPrompt;
        return { parts: [{ type: "text", text: "<content>正文。</content>" }] };
      }
    });

    await client.render(renderInput("..."));

    assert.equal(seenSystemPrompt, "# Writer\n只返回正文。");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writer prompt template controls the provider system prompt and conversation", async () => {
  const root = scaffoldRoot("rp-writer-template-");
  try {
    const packet = storyPacket("Template current situation.");
    const template: PromptTemplateSpec = {
      entries: [
        { kind: "message", role: "system", content: "Template system" },
        { kind: "message", role: "assistant", content: "fake assistant example" },
        { kind: "marker", marker: "story_elements" }
      ]
    };
    let seenSystemPrompt = "";
    let seenMessages: Array<{ role: string; content: unknown }> = [];
    const client = createConfiguredWriterClient({
      projectRoot: root,
      ctx: fakeCtx,
      promptTemplate: template,
      complete: async (_model, request): Promise<Completion> => {
        seenSystemPrompt = request.systemPrompt;
        seenMessages = request.messages as Array<{ role: string; content: unknown }>;
        return { parts: [{ type: "text", text: "<content>正文。</content>" }] };
      }
    });

    assert.equal(await client.render({ history: [], packet }), "正文。");

    assert.equal(seenSystemPrompt, "Template system");
    assert.equal(seenMessages[0]?.role, "assistant");
    assert.deepEqual(seenMessages[0]?.content, [{ type: "text", text: "fake assistant example" }]);
    assert.equal(seenMessages[1]?.role, "user");
    assert.deepEqual(seenMessages[1]?.content, [{ type: "text", text: formatPacketForWriter(packet) }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without a revision config the draft is returned as-is (back-compatible)", async () => {
  const root = scaffoldRoot("rp-writer-norev-");
  try {
    let calls = 0;
    const client = createConfiguredWriterClient({
      projectRoot: root,
      ctx: fakeCtx,
      complete: async (): Promise<Completion> => {
        calls += 1;
        return { parts: [{ type: "text", text: "<content>初稿。</content>" }] };
      }
    });

    assert.equal(await client.render(renderInput("...")), "初稿。");
    assert.equal(calls, 1, "no revision config ⇒ only the single draft call runs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with a revision config the draft passes the mandatory critics before it is returned", async () => {
  const root = scaffoldRoot("rp-writer-rev-");
  try {
    const systemPrompts: string[] = [];
    const client = createConfiguredWriterClient({
      projectRoot: root,
      ctx: fakeCtx,
      revision: { bannedWords: ["忽然"] },
      complete: async (_model, request): Promise<Completion> => {
        systemPrompts.push(request.systemPrompt);
        // The draft call uses the writer system prompt; the two critic calls use
        // their own preset prompts. All return prose/PASS so no rewrite happens.
        if (/审稿人/.test(request.systemPrompt)) {
          return { parts: [{ type: "text", text: "PASS" }] };
        }
        return { parts: [{ type: "text", text: "<content>初稿正文。</content>" }] };
      }
    });

    const prose = await client.render(renderInput("当前要素", [{ kind: "custom-prose", content: "上一段已发布的正文。" }]));

    assert.equal(prose, "初稿正文。");
    // Draft + inertia critic + cliché critic = three calls.
    assert.equal(systemPrompts.length, 3);
    assert.ok(systemPrompts.some((p) => /惯性审稿人/.test(p)), "inertia critic must run");
    assert.ok(systemPrompts.some((p) => /八股审稿人/.test(p)), "cliché critic must run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a flagging critic drives a rewrite that becomes the returned prose", async () => {
  const root = scaffoldRoot("rp-writer-rev-rewrite-");
  try {
    let inertiaCalls = 0;
    const client = createConfiguredWriterClient({
      projectRoot: root,
      ctx: fakeCtx,
      revision: { bannedWords: [] },
      complete: async (_model, request): Promise<Completion> => {
        const sp = request.systemPrompt;
        if (/惯性审稿人/.test(sp)) {
          inertiaCalls += 1;
          return { parts: [{ type: "text", text: inertiaCalls === 1 ? "ISSUES\n- 与上一段重复。" : "PASS" }] };
        }
        if (/八股审稿人/.test(sp)) {
          return { parts: [{ type: "text", text: "PASS" }] };
        }
        if (/执笔者。/.test(sp)) {
          return { parts: [{ type: "text", text: "<content>修订后的正文。</content>" }] };
        }
        return { parts: [{ type: "text", text: "<content>初稿正文。</content>" }] };
      }
    });

    const prose = await client.render(renderInput("...", [{ kind: "custom-prose", content: "上一段。" }]));

    assert.equal(prose, "修订后的正文。");
    assert.equal(inertiaCalls, 2, "inertia critic runs, flags, then re-runs after the rewrite");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("revision enhancer and critics use writerAgents models while rewrite stays on writer", async () => {
  const root = scaffoldRoot("rp-writer-rev-agents-");
  try {
    writeFileSync(
      join(root, ".pi", "agent", "settings.json"),
      JSON.stringify({
        writer: { provider: "opencode-go", model: "writer-main" },
        writerAgents: {
          styleEnhancer: { provider: "opencode-go", model: "style-model" },
          inertiaCritic: { provider: "opencode-go", model: "inertia-model" },
          clicheCritic: { provider: "opencode-go", model: "cliche-model" }
        }
      })
    );

    const calls: Array<{ model: unknown; systemPrompt: string; sessionId: string }> = [];
    const client = createConfiguredWriterClient({
      projectRoot: root,
      ctx: {
        sessionManager: { getSessionId: () => "session-1" },
        modelRegistry: {
          find(provider: string, modelId: string) {
            return provider === "opencode-go" ? { provider, id: modelId, api: "openai-completions" } : undefined;
          },
          async getApiKeyAndHeaders() {
            return { ok: true, apiKey: "test-key" };
          }
        }
      },
      revision: {
        bannedWords: ["忽然"],
        loadGuideBodies: () => [{ kind: "style", description: "风格", body: "增强感官细节。" }]
      },
      complete: async (model, request, options): Promise<Completion> => {
        calls.push({ model, systemPrompt: request.systemPrompt, sessionId: options.sessionId });
        if (/文风顾问/.test(request.systemPrompt)) {
          return { parts: [{ type: "text", text: "加强触觉。" }] };
        }
        if (/惯性审稿人/.test(request.systemPrompt) || /八股审稿人/.test(request.systemPrompt)) {
          return { parts: [{ type: "text", text: "PASS" }] };
        }
        if (/执笔者。/.test(request.systemPrompt)) {
          return { parts: [{ type: "text", text: "<content>增强后正文。</content>" }] };
        }
        return { parts: [{ type: "text", text: "<content>初稿正文。</content>" }] };
      }
    });

    assert.equal(await client.render(renderInput("当前要素", [{ kind: "custom-prose", content: "上一段。" }])), "增强后正文。");

    const byPrompt = (pattern: RegExp) => calls.find((call) => pattern.test(call.systemPrompt));
    assert.deepEqual(byPrompt(/# Writer/)?.model, { provider: "opencode-go", id: "writer-main", api: "openai-completions" });
    assert.deepEqual(byPrompt(/文风顾问/)?.model, { provider: "opencode-go", id: "style-model", api: "openai-completions" });
    assert.deepEqual(byPrompt(/惯性审稿人/)?.model, { provider: "opencode-go", id: "inertia-model", api: "openai-completions" });
    assert.deepEqual(byPrompt(/八股审稿人/)?.model, { provider: "opencode-go", id: "cliche-model", api: "openai-completions" });
    assert.deepEqual(byPrompt(/执笔者。/)?.model, { provider: "opencode-go", id: "writer-main", api: "openai-completions" });
    assert.equal(byPrompt(/文风顾问/)?.sessionId, "session-1:writer:styleEnhancer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writer and writerAgents thinking levels are appended to model ids", async () => {
  const root = scaffoldRoot("rp-writer-thinking-");
  try {
    writeFileSync(
      join(root, ".pi", "agent", "settings.json"),
      JSON.stringify({
        writer: { provider: "opencode-go", model: "writer-main", thinking: "high" },
        writerAgents: {
          styleEnhancer: { provider: "opencode-go", model: "style-model", thinking: "medium" },
          inertiaCritic: { provider: "opencode-go", model: "inertia-model", thinking: "low" },
          clicheCritic: { provider: "opencode-go", model: "cliche-model", thinking: "minimal" }
        }
      })
    );

    const calls: Array<{ model: unknown; systemPrompt: string }> = [];
    const client = createConfiguredWriterClient({
      projectRoot: root,
      ctx: {
        sessionManager: { getSessionId: () => "session-1" },
        modelRegistry: {
          find(provider: string, modelId: string) {
            return provider === "opencode-go" ? { provider, id: modelId, api: "openai-completions" } : undefined;
          },
          async getApiKeyAndHeaders() {
            return { ok: true, apiKey: "test-key" };
          }
        }
      },
      revision: {
        bannedWords: [],
        loadGuideBodies: () => [{ kind: "style", description: "风格", body: "增强感官细节。" }]
      },
      complete: async (model, request): Promise<Completion> => {
        calls.push({ model, systemPrompt: request.systemPrompt });
        if (/文风顾问/.test(request.systemPrompt)) {
          return { parts: [{ type: "text", text: "加强触觉。" }] };
        }
        if (/惯性审稿人/.test(request.systemPrompt) || /八股审稿人/.test(request.systemPrompt)) {
          return { parts: [{ type: "text", text: "PASS" }] };
        }
        if (/执笔者。/.test(request.systemPrompt)) {
          return { parts: [{ type: "text", text: "<content>增强后正文。</content>" }] };
        }
        return { parts: [{ type: "text", text: "<content>初稿正文。</content>" }] };
      }
    });

    assert.equal(await client.render(renderInput("当前要素")), "增强后正文。");

    const byPrompt = (pattern: RegExp) => calls.find((call) => pattern.test(call.systemPrompt));
    assert.deepEqual(byPrompt(/# Writer/)?.model, { provider: "opencode-go", id: "writer-main:high", api: "openai-completions" });
    assert.deepEqual(byPrompt(/文风顾问/)?.model, { provider: "opencode-go", id: "style-model:medium", api: "openai-completions" });
    assert.deepEqual(byPrompt(/惯性审稿人/)?.model, { provider: "opencode-go", id: "inertia-model:low", api: "openai-completions" });
    assert.deepEqual(byPrompt(/八股审稿人/)?.model, { provider: "opencode-go", id: "cliche-model:minimal", api: "openai-completions" });
    assert.deepEqual(byPrompt(/执笔者。/)?.model, { provider: "opencode-go", id: "writer-main:high", api: "openai-completions" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
