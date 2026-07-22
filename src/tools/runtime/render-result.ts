import { resultText, type ToolResult } from "./result.ts";

// TUI 折叠摘要：人类不该被大块工具输出淹没（见 tool-abstraction.md「TUI 折叠渲染」）。
// 纯函数，方便测试；展开态由真实 pi renderResult 渲染完整 content。
export function summarizeResult(result: ToolResult): string {
  const text = resultText(result);
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return "(empty)";
  }
  if (lines.length === 1) {
    return lines[0] ?? "";
  }
  return `${lines[0]} … (${lines.length} 行)`;
}
