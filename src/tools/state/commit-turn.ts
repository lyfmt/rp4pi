import { createHash } from "node:crypto";

import { SystemRuntimeError } from "../../systems/errors.ts";
import type { SystemOperation } from "../../systems/types.ts";
import type { ToolDefinition } from "../../types/pi.ts";
import { fail, ok, type ToolResult } from "../runtime/result.ts";
import { readRecord, requireStateToolContext } from "./context.ts";

export const commitTurnTool: ToolDefinition<ToolResult> = {
  name: "commit_turn",
  label: "RP System",
  description:
    "将剧情中已经裁定成立、且由世界专属规则管理的变化正式写入存档。一次可提交一项或多项变化，并返回生效结果。",
  parameters: {
    type: "object",
    required: ["operations"],
    properties: {
      operations: {
        type: "array",
        minItems: 1,
        description: "已经裁定成立、需要一并生效的世界规则变化。",
        items: {
          type: "object",
          required: ["system", "command", "input"],
          properties: {
            system: { type: "string", description: "负责这项变化的世界规则名称。" },
            command: { type: "string", description: "该世界规则允许执行的动作名称。" },
            input: { description: "执行该动作所需的具体内容。" }
          }
        }
      }
    }
  },
  async execute(toolCallId, params, _signal, _onUpdate, ctx) {
    const input = readRecord(params, "input");
    const operations = readOperations(input.operations);
    const context = requireStateToolContext(ctx);
    if (!context.systemRuntime) {
      throw new TypeError("状态工具上下文缺失：需要 systemRuntime。");
    }
    if (!context.piSessionId) {
      throw new TypeError("commit_turn 需要可信的 Pi session id。");
    }
    const saveId = context.stateStore.getActiveSaveId();
    if (!saveId) {
      throw new TypeError("当前没有活跃存档。");
    }

    const requestId = createScopedRequestId(context.piSessionId, toolCallId);
    let receipt;
    try {
      receipt = await context.systemRuntime.commit({
        saveId,
        requestId,
        caller: { kind: "gm", sessionId: context.piSessionId },
        operations
      });
    } catch (error) {
      if (!(error instanceof SystemRuntimeError)) {
        throw error;
      }
      return fail(
        `State commit failed [${error.code}] ${JSON.stringify(error.context)}`,
        error
      );
    }

    return ok(`State committed at revision ${receipt.revision}.`, {
      ok: true,
      requestId,
      ...receipt
    });
  }
};

function createScopedRequestId(sessionId: string, toolCallId: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["pi-tool", sessionId, toolCallId]))
    .digest("hex");
}

function readOperations(value: unknown): readonly [SystemOperation, ...SystemOperation[]] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("operations 必须是非空数组。");
  }
  return value.map((operation, index) => {
    if (
      !isRecord(operation) ||
      typeof operation.system !== "string" ||
      typeof operation.command !== "string" ||
      !Object.hasOwn(operation, "input")
    ) {
      throw new TypeError(`operations[${index}] 需要 system、command 和 input。`);
    }
    return {
      system: operation.system,
      command: operation.command,
      input: operation.input
    };
  }) as [SystemOperation, ...SystemOperation[]];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
