import { parseDirectionPacket } from "../../runtime/direction-packet.ts";
import type { ToolDefinition } from "../../types/pi.ts";
import { done, type ToolResult } from "../runtime/result.ts";

export const submitDirectionPacketTool: ToolDefinition<ToolResult> = {
  name: "submit_direction_packet",
  label: "RP 叙事",
  description:
    "提交本次裁定的玩家可见结果。需要叙事正文时提供已经成立的故事要素；需要直接答复时提供答复文本。提交后结束本次裁定。",
  parameters: {
    type: "object",
    // 只强制 needsRender：storyElements / directReply 二选一，逼模型两个都填
    // 只会得到一份注定被丢弃的编造内容（parseDirectionPacket 会按分支归一化缺省值）。
    required: ["needsRender"],
    properties: {
      storyElements: {
        type: "object",
        description:
          "needsRender=true 时必填：已经裁定成立、必须体现在玩家可见叙事中的事实与素材，不写完整正文。needsRender=false 时省略。",
        properties: {
          currentSituation: { type: "string", description: "玩家行动处理完毕后，场景此刻的实际情况。" },
          playerIntent: { type: "string", description: "玩家尝试做什么，以及裁定后实际推进到了哪里。" },
          visibleChanges: {
            type: "array",
            items: { type: "string" },
            description: "本次裁定后，玩家能够察觉且已经发生的变化。"
          },
          presentCharacters: {
            type: "array",
            items: { type: "string" },
            description: "此刻实际在场并可能进入正文的角色。"
          },
          characterActions: {
            type: "array",
            description: "各角色已经确定的言行与反应。",
            items: {
              type: "object",
              required: ["name", "action"],
              properties: {
                name: { type: "string", description: "角色名称。" },
                action: { type: "string", description: "该角色已经确定的言行与反应。" }
              }
            }
          },
          tension: { type: "string", description: "场景结束时仍未解决的压力、悬念或行动钩子。" }
        }
      },
      needsRender: { type: "boolean", description: "是否需要生成玩家可见的叙事正文。true 走 storyElements，false 走 directReply。" },
      directReply: { type: "string", description: "needsRender=false 时必填：直接交给玩家的答复。needsRender=true 时省略。" }
    }
  },
  execute(_toolCallId, params) {
    const packet = parseDirectionPacket(params);
    const mode = packet.needsRender ? "writer render" : "direct reply";
    // submit 是一轮的收口动作：terminate 让 GM 循环在此停下，由 writer 接手正文。
    return done(`Direction packet submitted for ${mode}.`, { packet });
  }
};
