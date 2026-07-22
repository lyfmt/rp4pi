import type { DirectionPacket } from "./direction-packet.ts";

const FULL_PROSE_BUDGET_CHARS = 40000;
const DIGEST_BUDGET_CHARS = 20000;

export type WriterMessage = {
  role: "assistant" | "user";
  content: string;
};

export type WriterHistoryItem =
  | {
      kind: "custom-prose";
      content: string;
    }
  | {
      kind: "direction-packet";
      packet: DirectionPacket;
    }
  | {
      kind: "user" | "gm" | "tool-result";
      content: string;
    };

export function buildWriterMessages(history: readonly WriterHistoryItem[], currentPacket: DirectionPacket): WriterMessage[] {
  return [...buildPriorContextMessages(history), { role: "user", content: formatPacketForWriter(currentPacket) }];
}

function buildPriorContextMessages(history: readonly WriterHistoryItem[]): WriterMessage[] {
  const messages = buildFullProseMessages(history);
  const digest = buildPlotDigest(history);

  if (digest.length > 0) {
    messages.unshift({ role: "assistant", content: digest });
  }

  return messages;
}

export function buildFullProseMessages(history: readonly WriterHistoryItem[]): WriterMessage[] {
  const messages: WriterMessage[] = [];
  let usedChars = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item?.kind !== "custom-prose") {
      continue;
    }

    const nextUsedChars = usedChars + item.content.length;
    if (nextUsedChars > FULL_PROSE_BUDGET_CHARS) {
      continue;
    }

    messages.unshift({ role: "assistant", content: item.content });
    usedChars = nextUsedChars;
  }

  return messages;
}

export function buildPlotDigest(history: readonly WriterHistoryItem[]): string {
  const elements = history
    .filter(isRenderableDirectionPacketItem)
    .map((item) => formatStoryElementsDigest(item.packet))
    .filter((digest) => digest.length > 0);

  if (elements.length === 0) {
    return "";
  }

  return fitFromEnd(["Prior story elements:", ...elements].join("\n"), DIGEST_BUDGET_CHARS);
}

function fitFromEnd(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const header = "Prior story elements:\n";
  if (maxChars <= header.length) {
    return header.slice(0, maxChars);
  }

  return `${header}${value.slice(-(maxChars - header.length))}`;
}

export function formatPacketForWriter(packet: DirectionPacket): string {
  if (!packet.needsRender) {
    return `Direct reply: ${packet.directReply}`;
  }
  return [
    "# Story Elements",
    "",
    `Current situation: ${packet.storyElements.currentSituation}`,
    `Player intent: ${packet.storyElements.playerIntent}`,
    "Visible changes:",
    ...formatList(packet.storyElements.visibleChanges),
    "Present characters:",
    ...formatList(packet.storyElements.presentCharacters),
    ...formatCharacterActions(packet.storyElements.characterActions),
    `Tension: ${packet.storyElements.tension}`,
    "",
    "Write the player-visible prose from these current story elements. Do not summarize these fields back to the player."
  ].join("\n");
}

// characterActions 是本轮各角色已裁定成立的行动依据（来自 role 子代理、去矛盾后）。
// 空则整段省略（纯独白/环境回合，避免给 writer 塞空清单）；非空则作为角色行为的权威来源。
function formatCharacterActions(actions: readonly { name: string; action: string }[]): string[] {
  if (actions.length === 0) {
    return [];
  }
  return [
    "Character actions (authoritative — write each character's behavior from these, do not invent):",
    ...actions.map((entry) => (entry.name.length > 0 ? `- ${entry.name}：${entry.action}` : `- ${entry.action}`))
  ];
}

function formatStoryElementsDigest(packet: Extract<DirectionPacket, { needsRender: true }>): string {
  return [
    packet.storyElements.currentSituation,
    packet.storyElements.playerIntent,
    ...packet.storyElements.visibleChanges,
    packet.storyElements.tension
  ]
    .filter((entry) => entry.length > 0)
    .join(" ");
}

function isRenderableDirectionPacketItem(
  item: WriterHistoryItem
): item is Extract<WriterHistoryItem, { kind: "direction-packet" }> & { packet: Extract<DirectionPacket, { needsRender: true }> } {
  return item.kind === "direction-packet" && item.packet.needsRender;
}

function formatList(items: readonly string[]): string[] {
  if (items.length === 0) {
    return ["- "];
  }
  return items.map((item) => `- ${item}`);
}
