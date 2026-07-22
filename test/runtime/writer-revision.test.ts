import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(new URL("../../src/runtime/writer-revision.ts", import.meta.url).pathname).href);
const reviseProse = mod.reviseProse as typeof import("../../src/runtime/writer-revision.js").reviseProse;

type RevisionModelStage = import("../../src/runtime/writer-revision.js").RevisionModelStage;
type Call = { stage: RevisionModelStage; systemPrompt: string; userContent: string };

// A scripted callModel: responds per invocation from a queue keyed by a matcher
// on the system prompt, so a test can pin exactly what each stage returns.
function scriptedCallModel(responders: Array<{ match: RegExp; reply: (call: Call) => string }>) {
  const calls: Call[] = [];
  const callModel = async (stage: RevisionModelStage, systemPrompt: string, userContent: string): Promise<string> => {
    calls.push({ stage, systemPrompt, userContent });
    const responder = responders.find((r) => r.match.test(systemPrompt));
    if (!responder) {
      throw new Error(`no scripted responder for system prompt: ${systemPrompt.slice(0, 40)}`);
    }
    return responder.reply({ stage, systemPrompt, userContent });
  };
  return { callModel, calls };
}

const baseInput = {
  draft: "初稿正文。",
  storyElements: "# Story Elements\n...",
  priorProse: [] as string[],
  bannedWords: [] as string[],
  writingGuides: [] as { kind: string; description: string; body: string }[]
};

test("both critics pass on the first round → the draft is returned unchanged, no rewrite", async () => {
  const { callModel, calls } = scriptedCallModel([
    { match: /惯性审稿人/, reply: () => "PASS" },
    { match: /八股审稿人/, reply: () => "PASS" }
  ]);

  const result = await reviseProse({ ...baseInput, callModel });

  assert.equal(result, "初稿正文。");
  // Exactly the two critics ran; no enhancer (no guides), no rewrite.
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => /审稿人/.test(c.systemPrompt)));
  assert.deepEqual(calls.map((c) => c.stage).sort(), ["clicheCritic", "inertiaCritic"]);
});

test("style enhancement runs first only when writing guides are present, and feeds a rewrite", async () => {
  const order: string[] = [];
  const { callModel } = scriptedCallModel([
    { match: /文风顾问/, reply: () => { order.push("enhance"); return "建议：增加嗅觉细节。"; } },
    { match: /执笔者。/, reply: () => { order.push("rewrite"); return "<content>增强后的正文。</content>"; } },
    { match: /惯性审稿人/, reply: () => { order.push("inertia"); return "PASS"; } },
    { match: /八股审稿人/, reply: () => { order.push("cliche"); return "PASS"; } }
  ]);

  const result = await reviseProse({
    ...baseInput,
    writingGuides: [{ kind: "style", description: "风格", body: "多用感官。" }],
    callModel
  });

  assert.equal(result, "增强后的正文。");
  // Enhancement + its rewrite happen before the critics.
  assert.deepEqual(order, ["enhance", "rewrite", "inertia", "cliche"]);
});

test("enhancer answering 无 skips the rewrite", async () => {
  const order: string[] = [];
  const { callModel } = scriptedCallModel([
    { match: /文风顾问/, reply: () => { order.push("enhance"); return "无"; } },
    { match: /执笔者。/, reply: () => { order.push("rewrite"); return "<content>不应发生。</content>"; } },
    { match: /惯性审稿人/, reply: () => { order.push("inertia"); return "PASS"; } },
    { match: /八股审稿人/, reply: () => { order.push("cliche"); return "PASS"; } }
  ]);

  const result = await reviseProse({
    ...baseInput,
    writingGuides: [{ kind: "style", description: "风格", body: "x" }],
    callModel
  });

  assert.equal(result, "初稿正文。");
  assert.deepEqual(order, ["enhance", "inertia", "cliche"]);
});

test("a critic that flags ISSUES triggers a rewrite, then the re-critic pass accepts it", async () => {
  let inertiaRound = 0;
  let rewrites = 0;
  const { callModel } = scriptedCallModel([
    { match: /惯性审稿人/, reply: () => (inertiaRound++ === 0 ? "ISSUES\n- “雾气”意象与第 1 段重复。" : "PASS") },
    { match: /八股审稿人/, reply: () => "PASS" },
    { match: /执笔者。/, reply: () => { rewrites++; return "<content>去掉重复后的正文。</content>"; } }
  ]);

  const result = await reviseProse({
    ...baseInput,
    priorProse: ["第一段：雾气弥漫。"],
    callModel
  });

  assert.equal(result, "去掉重复后的正文。");
  assert.equal(rewrites, 1, "exactly one rewrite from the flagged round");
  assert.equal(inertiaRound, 2, "inertia critic ran twice (flag, then pass)");
});

test("banned words are passed to the cliché critic and its issues drive a rewrite", async () => {
  let clicheSeen = "";
  // The cliché critic flags on its first look (draft still contains 忽然) and
  // passes once the draft has been rewritten ("清理" appears).
  const { callModel } = scriptedCallModel([
    { match: /惯性审稿人/, reply: () => "PASS" },
    {
      match: /八股审稿人/,
      reply: (c) => {
        clicheSeen = c.userContent;
        return /忽然/.test(c.userContent) && !c.userContent.includes("清理") ? "ISSUES\n- 命中“忽然”。" : "PASS";
      }
    },
    { match: /执笔者。/, reply: () => "<content>清理套话后的正文。</content>" }
  ]);

  const result = await reviseProse({
    ...baseInput,
    draft: "他忽然停下。",
    bannedWords: ["忽然", "顿时"],
    callModel
  });

  assert.equal(result, "清理套话后的正文。");
  assert.match(clicheSeen, /忽然/);
  assert.match(clicheSeen, /顿时/);
});

test("persistent issues are bounded by maxRounds and return the last rewrite (never blocks)", async () => {
  let rewrites = 0;
  const { callModel } = scriptedCallModel([
    { match: /惯性审稿人/, reply: () => "ISSUES\n- 仍重复。" },
    { match: /八股审稿人/, reply: () => "PASS" },
    { match: /执笔者。/, reply: () => { rewrites++; return `<content>第 ${rewrites} 次重写。</content>`; } }
  ]);

  const result = await reviseProse({ ...baseInput, priorProse: ["x"], maxRounds: 2, callModel });

  // Two rounds, each flagged → two rewrites; the last one is returned.
  assert.equal(rewrites, 2);
  assert.equal(result, "第 2 次重写。");
});

test("an empty rewrite does not wipe the turn — the prior draft is kept", async () => {
  const { callModel } = scriptedCallModel([
    { match: /惯性审稿人/, reply: () => "ISSUES\n- 重复。" },
    { match: /八股审稿人/, reply: () => "PASS" },
    { match: /执笔者。/, reply: () => "" }
  ]);

  const result = await reviseProse({ ...baseInput, priorProse: ["x"], maxRounds: 1, callModel });
  assert.equal(result, "初稿正文。");
});
