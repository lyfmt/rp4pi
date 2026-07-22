import type { AttributeSpec } from "../../world/schema.ts";
import type { AttributeValue } from "../../state/schema.ts";
import type { ToolDefinition } from "../../types/pi.ts";
import { ok, type ToolResult } from "../runtime/result.ts";
import { readRecord, readString, requireStateToolContext } from "./context.ts";

// Generic, world-driven attribute writer. Unlike the fixed-core tools
// (update_player_status etc.), this one tool serves *every* world-declared
// attribute: the world's AttributeSpec[] flows in through the tool context and
// decides which names are legal and how each value is coerced/bounded. A world
// adds "sanity" or "karma" by declaring it in world.yaml — no new tool code.
export const updateAttributeTool: ToolDefinition<ToolResult> = {
  name: "update_attribute",
  label: "RP 状态",
  description: "更新当前世界已经声明的属性值，并按照该属性规定的类型和范围保存。",
  parameters: {
    type: "object",
    required: ["name", "value"],
    properties: {
      name: { type: "string", description: "当前世界已经声明的属性名称。" },
      value: { description: "属性的新值，必须符合其类型和取值范围。" }
    }
  },
  execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const parsedInput = readRecord(params, "input");
    const toolContext = requireStateToolContext(ctx);
    const specs = toolContext.attributeSpecs ?? [];
    const name = readString(parsedInput, "name");

    const spec = specs.find((entry) => entry.name === name);
    if (!spec) {
      const known = specs.map((entry) => entry.name).join(", ") || "（本世界未声明任何属性）";
      throw new TypeError(`未知属性 "${name}"。本世界可用属性：${known}。`);
    }

    const value = coerce(spec, parsedInput.value);
    toolContext.stateStore.mutateState((draft) => {
      draft.attributes[name] = value;
    });
    return ok(`Attribute updated: ${name} = ${String(value)}`);
  }
};

// Coerce the model's raw value to the attribute's declared type, applying
// int bounds. Kept permissive on the entry (numbers as strings, etc.) in the
// same spirit as the other state readers — the domain check is the bounds.
function coerce(spec: AttributeSpec, raw: unknown): AttributeValue {
  if (spec.kind === "int") {
    const num = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(num)) {
      throw new TypeError(`属性 "${spec.name}" 需要整数，收到 ${describe(raw)}。`);
    }
    if (spec.min !== undefined && num < spec.min) {
      throw new RangeError(`属性 "${spec.name}" 不能小于 ${spec.min}。`);
    }
    if (spec.max !== undefined && num > spec.max) {
      throw new RangeError(`属性 "${spec.name}" 不能大于 ${spec.max}。`);
    }
    return num;
  }
  if (spec.kind === "bool") {
    if (typeof raw === "boolean") return raw;
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new TypeError(`属性 "${spec.name}" 需要布尔值，收到 ${describe(raw)}。`);
  }
  // string
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  throw new TypeError(`属性 "${spec.name}" 需要文本，收到 ${describe(raw)}。`);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
