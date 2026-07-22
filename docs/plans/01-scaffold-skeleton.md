# 阶段 1：项目骨架实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 建立一个 tavern2agent 风格的最小 pi TypeScript 项目骨架，为后续 state、writer、OV、slash commands 接线留出稳定位置。

**架构：** `extension.ts` 只做注册；工具契约与实现同文件；`tools/registry.ts` 只收集注册；prompt 文件放 `agents/` 和 `.pi/agents/`；入口 skill 为 `skills/start-game/SKILL.md`。此阶段不实现业务状态，只保证项目结构、类型检查和启动脚本存在。

**技术栈：** TypeScript、pi extension、项目级 `.pi/settings.json`、Markdown prompt。

---

## 文件结构

创建：

```text
package.json
tsconfig.json
extension.ts
start.sh
.gitignore
.pi/settings.json
.pi/agents/writer.md
agents/preset.json
agents/gm-core.md
agents/gm-tools.md
agents/gm-output.md
skills/start-game/SKILL.md
src/runtime/paths.ts
src/runtime/config.ts
src/tools/registry.ts
src/tools/runtime/ping.ts
src/tools/runtime/result.ts
src/tools/runtime/render-result.ts
src/types/pi.ts
```

职责：

| 文件 | 职责 |
|---|---|
| `extension.ts` | pi 注册入口：技能路径、prompt 注入、工具注册、hook 占位 |
| `src/tools/registry.ts` | 注册所有工具，不放工具业务逻辑 |
| `src/tools/runtime/ping.ts` | 最小 smoke tool，验证工具注册 |
| `src/tools/runtime/result.ts` | 统一 tool result 包装 |
| `src/tools/runtime/render-result.ts` | 大块输出折叠渲染 helper 占位 |
| `src/runtime/paths.ts` | 从 extension 位置推导项目路径 |
| `src/runtime/config.ts` | 读取环境变量和默认配置 |
| `src/types/pi.ts` | 最小 pi 类型适配，后续按真实 API 收紧 |
| `agents/*.md` | GM prompt 模块 |
| `.pi/agents/writer.md` | writer agent prompt |
| `skills/start-game/SKILL.md` | 开局入口 |

## 任务 1：创建 TS 工程基线

- [ ] **步骤 1：创建 `package.json`**

包含脚本：

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --test"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.0.0"
  }
}
```

- [ ] **步骤 2：创建 `tsconfig.json`**

启用 strict、NodeNext、ES2024。

- [ ] **步骤 3：运行类型检查**

运行：

```bash
npm run typecheck
```

预期：如果还没有源文件，可通过或只报缺少 input；后续任务补齐。

## 任务 2：创建 pi extension 骨架

- [ ] **步骤 1：创建 `src/types/pi.ts`**

定义最小接口：

```ts
export interface PiLike {
  registerTool?: (tool: unknown) => void;
  registerSkillPath?: (path: string) => void;
  registerHook?: (name: string, handler: unknown) => void;
}
```

- [ ] **步骤 2：创建 `extension.ts`**

只做：

```text
resolve project root
register skills/start-game
registerAllTools(pi)
register hook placeholders
```

- [ ] **步骤 3：创建路径/config helper**

`src/runtime/paths.ts` 提供：

```ts
resolveProjectRoot(extensionUrlOrDir: string): string
```

`src/runtime/config.ts` 提供：

```ts
loadRuntimeConfig()
```

- [ ] **步骤 4：运行类型检查**

运行：

```bash
npm run typecheck
```

预期：PASS。

## 任务 3：创建工具注册骨架

- [ ] **步骤 1：创建 tool result helper**

`src/tools/runtime/result.ts`：

```ts
export type ToolResult = {
  content: string;
  details?: Record<string, unknown>;
};

export function ok(content: string, details?: Record<string, unknown>): ToolResult {
  return details ? { content, details } : { content };
}
```

- [ ] **步骤 2：创建 `ping` 工具**

`src/tools/runtime/ping.ts` 定义工具名、description、parameters、execute。

- [ ] **步骤 3：创建 `src/tools/registry.ts`**

导出：

```ts
export function registerAllTools(pi: PiLike): void
```

- [ ] **步骤 4：运行类型检查**

运行：

```bash
npm run typecheck
```

预期：PASS。

## 任务 4：创建 prompt 与 skill 文件

- [ ] **步骤 1：创建 GM prompt 模块**

最小内容：

```text
gm-core: 你是 GM，负责裁定、推进、调用工具。
gm-tools: 状态变化必须通过工具。
gm-output: renderable turn 必须提交 direction packet。
```

- [ ] **步骤 2：创建 writer prompt**

要求 writer 只返回正文字符串，不写解释，不写状态更新。

- [ ] **步骤 3：创建 start-game skill**

说明如何开始 demo，不做世界模板选择。

- [ ] **步骤 4：创建 `agents/preset.json`**

列出 GM prompt 模块顺序。

## 任务 5：创建启动脚本

- [ ] **步骤 1：创建 `start.sh`**

参考 `../template/tavern2agent/scripts/start.sh` 的项目级 pi 隔离原则。若原脚本过复杂，先创建最小版本，保留后续替换点。

- [ ] **步骤 2：设置可执行权限**

运行：

```bash
chmod +x start.sh
```

- [ ] **步骤 3：运行静态验证**

运行：

```bash
npm run typecheck
test -x start.sh
```

预期：全部通过。

## 阶段验收

- [ ] `npm run typecheck` 通过。
- [ ] `extension.ts` 不包含工具业务逻辑。
- [ ] `tools/registry.ts` 只注册工具。
- [ ] prompt 文件存在。
- [ ] `skills/start-game/SKILL.md` 存在。
