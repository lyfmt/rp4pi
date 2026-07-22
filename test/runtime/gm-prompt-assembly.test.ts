import assert from "node:assert/strict";
import test from "node:test";

import { assembleGmContextMessages, gmPromptPathsForResources } from "../../extensions/core.ts";
import { createWriterProseMessage, type RuntimeMessage } from "../../src/runtime/prose-message.ts";
import type { PromptTemplateSpec } from "../../src/world/schema.ts";

test("without a gm template context assembly preserves filtered history plus hook prompts", () => {
  const messages: RuntimeMessage[] = [
    { role: "user", content: "I open the door." },
    createWriterProseMessage("Rendered prose should stay hidden from GM.")
  ];

  assert.deepEqual(
    assembleGmContextMessages({
      messages,
      hookPrompts: ["Rain intensifies."]
    }),
    [
      { role: "user", content: "I open the door." },
      { role: "user", content: "Rain intensifies." }
    ]
  );
});

test("gm template rebuilds context order and downgrades literal system entries to user messages", () => {
  const template: PromptTemplateSpec = {
    entries: [
      { kind: "message", role: "system", content: "GM system guidance." },
      { kind: "message", role: "assistant", content: "Fake assistant example." },
      { kind: "marker", marker: "chat_history" },
      { kind: "marker", marker: "hook_prompts" }
    ]
  };

  assert.deepEqual(
    assembleGmContextMessages({
      promptTemplate: template,
      messages: [
        { role: "user", content: "Player turn." },
        createWriterProseMessage("Filtered rendered prose.")
      ],
      hookPrompts: ["Hook guidance."]
    }),
    [
      { role: "user", content: "GM system guidance." },
      { role: "assistant", content: "Fake assistant example." },
      { role: "user", content: "Player turn." },
      { role: "user", content: "Hook guidance." }
    ]
  );
});

test("gm template may omit chat history but emits a warning", () => {
  const warnings: string[] = [];
  const template: PromptTemplateSpec = {
    entries: [{ kind: "message", role: "user", content: "Only the template matters." }]
  };

  const messages = assembleGmContextMessages({
    promptTemplate: template,
    messages: [{ role: "user", content: "Hidden by template." }],
    hookPrompts: [],
    log: (message) => warnings.push(message)
  });

  assert.deepEqual(messages, [{ role: "user", content: "Only the template matters." }]);
  assert.deepEqual(warnings, ["GM prompt template omitted chat_history; real conversation history will not be sent."]);
});

test("gm prompt paths are only exposed through resources when no gm template is present", () => {
  const paths = ["/world/prompts/gm.md"];
  assert.deepEqual(gmPromptPathsForResources({ gmPromptPaths: paths, promptTemplates: {} }), paths);
  assert.deepEqual(
    gmPromptPathsForResources({
      gmPromptPaths: paths,
      promptTemplates: { gm: { entries: [{ kind: "message", role: "user", content: "template" }] } }
    }),
    []
  );
});
