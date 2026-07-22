import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const directionPacketModule = await import(
  pathToFileURL(new URL("../../src/runtime/direction-packet.ts", import.meta.url).pathname).href
);
const writerHistoryModule = await import(pathToFileURL(new URL("../../src/runtime/writer-history.ts", import.meta.url).pathname).href);

const parseDirectionPacket =
  directionPacketModule.parseDirectionPacket as typeof import("../../src/runtime/direction-packet.js").parseDirectionPacket;
const buildWriterMessages =
  writerHistoryModule.buildWriterMessages as typeof import("../../src/runtime/writer-history.js").buildWriterMessages;

test("buildWriterMessages sends previous custom prose and current story elements to writer", () => {
  const currentPacket = parseDirectionPacket({
    storyElements: {
      currentSituation: "玩家和信使在医务间，桌上压着未送达的密信。",
      playerIntent: "玩家替信使包扎，并要求他说出密信原本要送往哪里。",
      visibleChanges: ["绷带重新扎紧", "信使把密信推到玩家手边"],
      presentCharacters: ["玩家", "受伤信使"],
      tension: "北门即将关闭。"
    },
    needsRender: true,
    directReply: ""
  });

  const messages = buildWriterMessages(
    [
      { kind: "user", content: "I go north." },
      { kind: "gm", content: "Calling update_location." },
      { kind: "tool-result", content: "location updated" },
      { kind: "custom-prose", content: "Rain hissed across the broken bridge." }
    ],
    currentPacket
  );

  assert.deepEqual(messages, [
    { role: "assistant", content: "Rain hissed across the broken bridge." },
    {
      role: "user",
      content: [
        "# Story Elements",
        "",
        "Current situation: 玩家和信使在医务间，桌上压着未送达的密信。",
        "Player intent: 玩家替信使包扎，并要求他说出密信原本要送往哪里。",
        "Visible changes:",
        "- 绷带重新扎紧",
        "- 信使把密信推到玩家手边",
        "Present characters:",
        "- 玩家",
        "- 受伤信使",
        "Tension: 北门即将关闭。",
        "",
        "Write the player-visible prose from these current story elements. Do not summarize these fields back to the player."
      ].join("\n")
    }
  ]);
});

test("buildWriterMessages passes reconciled character actions to writer as an authoritative section", () => {
  const currentPacket = parseDirectionPacket({
    storyElements: {
      currentSituation: "医务间，桌上压着密信。",
      playerIntent: "玩家追问密信去向。",
      presentCharacters: ["玩家", "韩越"],
      characterActions: [
        { name: "韩越", action: "咬牙撑起身，说密信要送往北营。" },
        "远处传来北门落闩的闷响。"
      ],
      tension: "北门即将关闭。"
    },
    needsRender: true,
    directReply: ""
  });

  const messages = buildWriterMessages([], currentPacket);
  const writerInput = messages[messages.length - 1]?.content ?? "";

  assert.match(writerInput, /Character actions \(authoritative/);
  assert.match(writerInput, /- 韩越：咬牙撑起身，说密信要送往北营。/);
  assert.match(writerInput, /- 远处传来北门落闩的闷响。/);
});

test("buildWriterMessages omits the character actions section when there are none", () => {
  const currentPacket = parseDirectionPacket({
    storyElements: { currentSituation: "空荡的驿站大厅。", presentCharacters: ["玩家"] },
    needsRender: true,
    directReply: ""
  });

  const messages = buildWriterMessages([], currentPacket);
  const writerInput = messages[messages.length - 1]?.content ?? "";

  assert.doesNotMatch(writerInput, /Character actions/);
});

test("buildWriterMessages keeps full prose under a 40000 character budget", () => {
  const currentPacket = parseDirectionPacket({
    storyElements: {
      currentSituation: "Now",
      playerIntent: "Continue."
    },
    needsRender: true,
    directReply: ""
  });
  const firstProse = "a".repeat(30000);
  const secondProse = "b".repeat(30000);

  const messages = buildWriterMessages(
    [
      { kind: "custom-prose", content: firstProse },
      { kind: "custom-prose", content: secondProse }
    ],
    currentPacket
  );

  const assistantChars = messages.filter((message) => message.role === "assistant").reduce((sum, message) => sum + message.content.length, 0);

  assert.equal(assistantChars, 30000);
  assert.equal(messages[0]?.content, secondProse);
});

test("buildWriterMessages mechanically digests prior story elements under a 20000 character budget", () => {
  const currentPacket = parseDirectionPacket({
    storyElements: {
      currentSituation: "Current",
      playerIntent: "The current scene advances."
    },
    needsRender: true,
    directReply: ""
  });
  const earlyPacket = parseDirectionPacket({
    storyElements: {
      currentSituation: "Early",
      playerIntent: "x".repeat(30000)
    },
    needsRender: true,
    directReply: ""
  });
  const laterPacket = parseDirectionPacket({
    storyElements: {
      currentSituation: "Middle",
      playerIntent: "The later player action.",
      visibleChanges: ["The later visible event."]
    },
    needsRender: true,
    directReply: ""
  });

  const messages = buildWriterMessages(
    [
      { kind: "direction-packet", packet: earlyPacket },
      { kind: "direction-packet", packet: laterPacket }
    ],
    currentPacket
  );

  assert.equal(messages[0]?.role, "assistant");
  assert.match(messages[0]?.content ?? "", /^Prior story elements:\n/);
  assert.match(messages[0]?.content ?? "", /The later player action\./);
  assert.match(messages[0]?.content ?? "", /The later visible event\./);
  assert.ok((messages[0]?.content.length ?? 0) <= 20000);
});
