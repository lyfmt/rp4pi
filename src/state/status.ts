import type { RpState } from "./schema.ts";

export function formatStatus(state: RpState): string {
  const lines = [
    `玩家：${state.player.name}`,
    `状态：${state.player.status}`,
    `地点：${state.player.location}`,
    `时间：第 ${state.time.day} 天 ${state.time.hour.toString().padStart(2, "0")}:00`,
    `场景：${state.scene.summary}`
  ];

  const attributes = Object.entries(state.attributes);
  if (attributes.length > 0) {
    lines.push("属性：", ...attributes.map(([name, value]) => `- ${name}: ${String(value)}`));
  }

  if (state.facts.length > 0) {
    lines.push("事实：", ...state.facts.map((fact) => `- [${fact.kind}] ${fact.text}`));
  }

  if (state.relationships.length > 0) {
    lines.push(
      "关系：",
      ...state.relationships.map((relationship) => `- ${relationship.source} -> ${relationship.target}：${relationship.stance}；${relationship.summary}`)
    );
  }

  return lines.join("\n");
}
