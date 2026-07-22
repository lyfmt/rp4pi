# 阶段 3：GM / Writer 两段式 Runtime 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 GM 提交 direction packet、writer 生成正文、正文 custom-message 展示、GM context 过滤 writer prose、成功后写 story snapshot 的完整回合链路。

**架构：** Pass A 是 GM agent 循环，只允许工具与 direction packet；Pass B 是 writer 渲染，只返回正文字符串。writer prose 作为 custom message 展示，不进入 GM 上下文。成功故事回合在 writer 成功后落 snapshot。

**技术栈：** TypeScript、pi hooks/custom message、node:test。

---

## 文件结构

创建：

```text
src/runtime/direction-packet.ts
src/runtime/turn-context.ts
src/runtime/writer-history.ts
src/runtime/writer-client.ts
src/runtime/prose-message.ts
src/runtime/context-filter.ts
src/runtime/turn-commit.ts
src/tools/state/submit-direction-packet.ts
test/runtime/direction-packet.test.ts
test/runtime/writer-history.test.ts
test/runtime/context-filter.test.ts
```

修改：

```text
src/tools/registry.ts
extension.ts
agents/gm-output.md
.pi/agents/writer.md
```

## Direction Packet 合同

```json
{
  "start": "",
  "end": "",
  "plot": "",
  "needsRender": true,
  "directReply": ""
}
```

规则：

- `needsRender=true`：调用 writer，展示 writer prose。
- `needsRender=false`：不调用 writer，展示 `directReply`。
- `directReply` 进入 GM context。
- writer prose 不进入 GM context。

## 任务 1：Direction packet schema

- [ ] **步骤 1：写失败测试**

验证：

- 合法 packet 可解析。
- `needsRender=true` 时允许 `directReply` 为空。
- `needsRender=false` 时要求 `directReply` 非空。
- `start/end/plot` 都是字符串。

- [ ] **步骤 2：实现 `src/runtime/direction-packet.ts`**

导出：

```ts
export type DirectionPacket = ...
export function parseDirectionPacket(value: unknown): DirectionPacket
```

- [ ] **步骤 3：运行测试**

```bash
npm test -- test/runtime/direction-packet.test.ts
npm run typecheck
```

预期：PASS。

## 任务 2：submit_direction_packet 工具

- [ ] **步骤 1：写工具测试**

验证：

- 工具不修改 state。
- 工具结果 details 中包含 packet。
- 工具返回可读摘要。

- [ ] **步骤 2：实现 `src/tools/state/submit-direction-packet.ts`**

只负责提交 packet，不落库、不调用 writer。

- [ ] **步骤 3：注册工具**

修改 `src/tools/registry.ts`。

- [ ] **步骤 4：运行测试**

```bash
npm test -- test/runtime/direction-packet.test.ts
npm run typecheck
```

预期：PASS。

## 任务 3：Writer history

- [ ] **步骤 1：写失败测试**

验证 Pass B history：

- previous custom prose 作为 assistant messages。
- previous user/GM tool results 不传给 writer。
- 当前 packet 是 final user message。
- full prose 层预算 40000 chars。
- digest 层预算 20000 chars。
- digest 由 prior packet `plot` 机械生成。

- [ ] **步骤 2：实现 `src/runtime/writer-history.ts`**

导出：

```ts
buildWriterMessages(history, currentPacket)
```

- [ ] **步骤 3：运行测试**

```bash
npm test -- test/runtime/writer-history.test.ts
npm run typecheck
```

预期：PASS。

## 任务 4：Custom prose message 与 GM context filter

- [ ] **步骤 1：写失败测试**

验证：

- writer prose message 可识别。
- context filter 会从 GM context 删除 writer prose custom message。
- 普通 assistant text 不删除。
- `directReply` 不删除。

- [ ] **步骤 2：实现 `src/runtime/prose-message.ts`**

定义 custom message 类型、创建函数、识别函数。

- [ ] **步骤 3：实现 `src/runtime/context-filter.ts`**

提供 pi hook 可调用的过滤函数。

- [ ] **步骤 4：接入 `extension.ts` hook**

注册上下文构建前过滤 hook。

- [ ] **步骤 5：运行测试**

```bash
npm test -- test/runtime/context-filter.test.ts
npm run typecheck
```

预期：PASS。

## 任务 5：Writer client 与 turn commit

- [ ] **步骤 1：写失败测试**

验证：

- writer 成功返回正文字符串后，调用 custom message writer。
- writer 失败不创建 story snapshot。
- writer 成功后创建 story snapshot。
- `needsRender=false` 不创建 story snapshot。

- [ ] **步骤 2：实现 `src/runtime/writer-client.ts`**

封装 pi writer agent 调用。若真实 pi API 尚不明确，先定义接口并用 adapter 占位：

```ts
export interface WriterClient {
  render(messages): Promise<string>;
}
```

- [ ] **步骤 3：实现 `src/runtime/turn-commit.ts`**

处理：

```text
packet needsRender
-> writer render
-> custom message
-> recordSuccessfulStorySnapshot
```

- [ ] **步骤 4：接入 extension hook**

在 GM 工具调用结束或 agent turn 结束处，识别最新 direction packet 并执行 turn commit。

- [ ] **步骤 5：运行测试**

```bash
npm test -- test/runtime/*.test.ts
npm run typecheck
```

预期：PASS。

## 阶段验收

- [ ] writer prose 能被标记为 custom message。
- [ ] GM context filter 不回灌 writer prose。
- [ ] `needsRender=true` 成功后写 story snapshot。
- [ ] writer 失败不写 story snapshot。
- [ ] `needsRender=false` 不写 story snapshot。
