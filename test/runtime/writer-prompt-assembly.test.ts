import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseDirectionPacket } from "../../src/runtime/direction-packet.ts";
import {
  buildFullProseMessages,
  buildPlotDigest,
  buildWriterMessages,
  formatPacketForWriter,
  type WriterHistoryItem
} from "../../src/runtime/writer-history.ts";
import {
  assembleWriterPrompt,
  buildWriterSystemPrompt,
  buildWritingGuidesCatalogue,
  type WritingGuideCatalogueEntry
} from "../../src/runtime/writer-client.ts";
import type { PromptTemplateSpec } from "../../src/world/schema.ts";

const guides: WritingGuideCatalogueEntry[] = [{ kind: "style", description: "叙事语气与节奏。" }];

test("without a template writer prompt assembly matches the existing system prompt and messages", () => {
  const root = scaffoldRoot("rp-writer-assembly-default-");
  try {
    const history = sampleHistory();
    const packet = samplePacket();

    const assembled = assembleWriterPrompt({
      projectRoot: root,
      writingGuides: guides,
      history,
      packet
    });

    assert.equal(assembled.systemPrompt, buildWriterSystemPrompt(root, guides));
    assert.deepEqual(assembled.messages, buildWriterMessages(history, packet));
    assert.deepEqual(assembled.revisionInputs, {
      storyElementsText: formatPacketForWriter(packet),
      priorProse: buildFullProseMessages(history).map((message) => message.content)
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writer template assembles system entries upward and preserves user/assistant message order", () => {
  const root = scaffoldRoot("rp-writer-assembly-template-", "# Writer base\n<content>...</content>");
  try {
    const history = sampleHistory();
    const packet = samplePacket();
    const template: PromptTemplateSpec = {
      entries: [
        { kind: "message", role: "assistant", content: "fake assistant example" },
        { kind: "marker", marker: "writer_base" },
        { kind: "message", role: "system", content: "World writer persona" },
        { kind: "message", role: "user", content: "fake user request" },
        { kind: "marker", marker: "prior_prose" },
        { kind: "marker", marker: "plot_digest" },
        { kind: "marker", marker: "writing_guides" },
        { kind: "marker", marker: "story_elements" }
      ]
    };

    const assembled = assembleWriterPrompt({
      projectRoot: root,
      writingGuides: guides,
      history,
      packet,
      promptTemplate: template
    });

    assert.equal(
      assembled.systemPrompt,
      ["# Writer base\n<content>...</content>", "World writer persona", buildWritingGuidesCatalogue(guides)].join("\n\n")
    );
    assert.deepEqual(assembled.messages, [
      { role: "assistant", content: "fake assistant example" },
      { role: "user", content: "fake user request" },
      ...buildFullProseMessages(history),
      { role: "assistant", content: buildPlotDigest(history) },
      { role: "user", content: formatPacketForWriter(packet) }
    ]);
    assert.deepEqual(assembled.revisionInputs, {
      storyElementsText: formatPacketForWriter(packet),
      priorProse: buildFullProseMessages(history).map((message) => message.content)
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function scaffoldRoot(prefix: string, writerMd = "# Writer\n只返回正文。"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".pi", "agents"), { recursive: true });
  writeFileSync(join(root, ".pi", "agents", "writer.md"), writerMd);
  return root;
}

function sampleHistory(): WriterHistoryItem[] {
  return [
    {
      kind: "direction-packet",
      packet: parseDirectionPacket({
        storyElements: {
          currentSituation: "Earlier scene.",
          playerIntent: "The player searched the desk.",
          visibleChanges: ["A brass key appeared."],
          tension: "The guard is near."
        },
        needsRender: true,
        directReply: ""
      })
    },
    { kind: "custom-prose", content: "Earlier rendered prose." }
  ];
}

function samplePacket() {
  return parseDirectionPacket({
    storyElements: {
      currentSituation: "A courier is at the door.",
      playerIntent: "The player helps the courier.",
      visibleChanges: ["The courier arrives."],
      presentCharacters: ["player", "courier"],
      characterActions: [],
      tension: "The sealed letter still needs delivery."
    },
    needsRender: true,
    directReply: ""
  });
}
