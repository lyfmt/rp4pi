// The final-draft revision pipeline (W-G). After the writer produces a draft
// (its tool-using render loop), the draft passes through this pipeline before it
// becomes player-visible prose — the hard "self-check" guarantee the plain loop
// could not make on its own:
//
//   1. Style enhancement (CONDITIONAL, runs first): only when the world ships
//      writing guides. A focused enhancer reads the guide bodies and returns
//      *suggestions*; the writer then rewrites the draft applying them. Its
//      output is a suggestion the writer adopts, never a silent overwrite.
//   2. Inertia critic (MANDATORY): flags where the draft obviously repeats prior
//      prose (repeated imagery / sentence shape / wording — a semantic judgement,
//      hence an LLM, not a substring check).
//   3. Cliché critic (MANDATORY): flags the world's banned words/register.
//   4. If either critic finds issues, the writer rewrites once with the combined
//      issues, then the two critics re-run. Bounded by REVISION_MAX_ROUNDS.
//
// Every call here is tool-less and single-shot; the writer keeps sole authorship
// of the prose (critics/enhancer only advise). The three agent system prompts are
// base-platform presets — the world only declares the banned-word list and the
// writing guides they draw on.

import { extractWriterProse } from "./writer-client.ts";

export type RevisionModelStage = "styleEnhancer" | "inertiaCritic" | "clicheCritic" | "rewrite";

/** A tool-less single-shot model call: stage + system prompt + user message in,
 * assistant's text out (thinking already stripped). Injected so this module has
 * no provider dependency and tests can script each stage. */
export type CallModel = (stage: RevisionModelStage, systemPrompt: string, userContent: string) => Promise<string>;

export type RevisionWritingGuide = { kind: string; description: string; body: string };

export type ReviseProseInput = {
  /** The writer's draft (already prose-extracted). */
  draft: string;
  /** The current story elements the draft renders (context for every stage). */
  storyElements: string;
  /** Prior player-visible prose, oldest→newest — the inertia critic's baseline. */
  priorProse: readonly string[];
  /** The world's banned words/register for the cliché critic (may be empty). */
  bannedWords: readonly string[];
  /** The world's writing guides; non-empty ⇒ the enhancement stage runs. */
  writingGuides: readonly RevisionWritingGuide[];
  callModel: CallModel;
  /** Max critic→rewrite→re-critic rounds. Defaults to REVISION_MAX_ROUNDS. */
  maxRounds?: number;
};

export const REVISION_MAX_ROUNDS = 2;

const ENHANCER_SYSTEM_PROMPT = [
  "你是这局角色扮演的文风顾问。下面给出本世界的写作指导、当前故事要素、以及执笔者的一版初稿。",
  "你的任务：对照写作指导，指出这版初稿在文风上可以增强的具体地方（感官密度、语气、节奏、意象、对白质感等），给出可操作的修改建议。",
  "只输出建议本身，逐条列出；不要重写正文，不要复述初稿，不要解释你的角色。若初稿文风已充分贴合指导、无需增强，只回复一行：无。"
].join("\n");

const INERTIA_SYSTEM_PROMPT = [
  "你是这局角色扮演的惯性审稿人。下面给出此前若干段已发布的正文，以及执笔者本轮的最新初稿。",
  "你的任务：找出最新初稿里与此前内容明显重复的部分——重复的意象、句式、措辞、场景描写套路、开头/结尾的惯用手法等（语义重复，不只是字面雷同）。",
  "判定规则：若存在明显重复，第一行输出 ISSUES，随后逐条列出重复点（引用初稿里的具体片段并说明和之前哪里雷同）。若没有明显重复，只输出一行：PASS。不要输出正文，不要解释你的角色。"
].join("\n");

const CLICHE_SYSTEM_PROMPT = [
  "你是这局角色扮演的八股审稿人。下面给出本世界的禁止用词表，以及执笔者本轮的最新初稿。",
  "你的任务：找出最新初稿里触犯禁止用词表的地方——不仅是字面命中，也包括这些词的明显变体与近义套话。",
  "判定规则：若存在触犯，第一行输出 ISSUES，随后逐条列出触犯的词/短语及其在初稿中的位置。若没有触犯，只输出一行：PASS。不要输出正文，不要解释你的角色。"
].join("\n");

const REWRITE_SYSTEM_PROMPT = [
  "你是这局角色扮演的执笔者。下面给出当前故事要素、你的上一版初稿、以及审稿意见。",
  "你的任务：据审稿意见一次性修订初稿，消除所有被指出的问题，同时保持正文的连贯与因果、忠于故事要素。",
  "只输出修订后的玩家可见正文本身；不要解释改了什么，不要复述故事要素或审稿意见，不要输出字段名或清单。"
].join("\n");

// Returns the final, revised player-visible prose.
export async function reviseProse(input: ReviseProseInput): Promise<string> {
  const maxRounds = input.maxRounds ?? REVISION_MAX_ROUNDS;
  let draft = input.draft;

  // Stage 1 — conditional style enhancement (suggestions → writer rewrite).
  if (input.writingGuides.length > 0) {
    const guideText = input.writingGuides.map((guide) => `## ${guide.kind}（${guide.description}）\n${guide.body}`).join("\n\n");
    const suggestions = (
      await input.callModel(
        "styleEnhancer",
        ENHANCER_SYSTEM_PROMPT,
        [`# 本世界写作指导\n${guideText}`, `# 当前故事要素\n${input.storyElements}`, `# 初稿\n${draft}`].join("\n\n")
      )
    ).trim();
    if (hasContent(suggestions)) {
      draft = await rewriteWithIssues(input, draft, [`文风增强建议：\n${suggestions}`]);
    }
  }

  // Stages 2–4 — mandatory critics with a bounded rewrite loop.
  for (let round = 0; round < maxRounds; round += 1) {
    const [inertia, cliche] = await Promise.all([
      runCritic(input.callModel, INERTIA_SYSTEM_PROMPT, [
        `# 此前已发布的正文\n${formatPriorProse(input.priorProse)}`,
        `# 最新初稿\n${draft}`
      ], "inertiaCritic"),
      runCritic(input.callModel, CLICHE_SYSTEM_PROMPT, [
        `# 禁止用词表\n${formatBannedWords(input.bannedWords)}`,
        `# 最新初稿\n${draft}`
      ], "clicheCritic")
    ]);

    const issues = [...inertia, ...cliche];
    if (issues.length === 0) {
      return draft;
    }
    draft = await rewriteWithIssues(input, draft, issues);
  }

  // Rounds exhausted: return the last rewrite. The pipeline always converges on a
  // draft the writer produced — never blocks a turn on an unsatisfiable critic.
  return draft;
}

// Run one critic and return its issues (empty ⇒ clean). A critic that answers
// PASS (or gives no substantive content) is treated as clean; anything else is
// its issue list, fed verbatim into the rewrite.
async function runCritic(
  callModel: CallModel,
  systemPrompt: string,
  userParts: string[],
  stage: Extract<RevisionModelStage, "inertiaCritic" | "clicheCritic">
): Promise<string[]> {
  const verdict = (await callModel(stage, systemPrompt, userParts.join("\n\n"))).trim();
  // Clean when: nothing said, an explicit PASS, or empty once the ISSUES marker
  // is stripped. Otherwise the remaining text is the issue list, fed to rewrite.
  if (verdict.length === 0 || /^PASS\b/i.test(verdict)) {
    return [];
  }
  const body = verdict.replace(/^ISSUES[:：]?\s*/i, "").trim();
  return body.length > 0 ? [body] : [];
}

async function rewriteWithIssues(input: ReviseProseInput, draft: string, issues: string[]): Promise<string> {
  const rewritten = await input.callModel(
    "rewrite",
    REWRITE_SYSTEM_PROMPT,
    [`# 当前故事要素\n${input.storyElements}`, `# 上一版初稿\n${draft}`, `# 审稿意见\n${issues.join("\n\n")}`].join("\n\n")
  );
  const prose = extractWriterProse(rewritten).trim();
  // A degenerate empty rewrite must not wipe the turn — keep the prior draft.
  return prose.length > 0 ? prose : draft;
}

function formatPriorProse(priorProse: readonly string[]): string {
  if (priorProse.length === 0) {
    return "（无。这是本局第一段正文，没有可对比的历史内容。）";
  }
  return priorProse.map((prose, index) => `〔第 ${index + 1} 段〕\n${prose}`).join("\n\n");
}

function formatBannedWords(bannedWords: readonly string[]): string {
  if (bannedWords.length === 0) {
    return "（本世界未声明禁止用词。仍请指出任何明显的套话/八股腔。）";
  }
  return bannedWords.map((word) => `- ${word}`).join("\n");
}

function hasContent(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed !== "无" && !/^无[。.]?$/.test(trimmed);
}
