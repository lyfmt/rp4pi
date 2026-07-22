# GM `commit_turn` Tool 与 Pi Binding 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:test-driven-development 和 superpowers:executing-plans。若调度子代理，必须显式设置项目允许的 `model` 与 `reasoning_effort=medium`；工具不能同时设置时禁止调度。

**目标：** 把 `SystemRuntime.commit()` 绑定为 GM 可调用的 `commit_turn`，并在新建/加载存档时激活 System lifecycle，同时把 module projection 接入状态读取。

**架构：** Pi adapter 只负责从真实 context 解析 session/save、使用 `stableDigest([sessionId, toolCallId])` 生成 requestId、注入可信 GM caller、规范化 operation envelope 和渲染 receipt/error。Runtime 按当前 branch epoch 隔离 receipt。System module 不看到 Pi context；`commit_turn` 不接收 direction packet、不调用 Writer、不返回 `terminate: true`。

**技术栈：** TypeScript、Pi `ToolDefinition`、Node 24、真实临时 SQLite、Node test runner。

---

## 前置条件

- 已完成 `2026-07-10-system-registry-persistence-migration.md`。
- 已完成 `2026-07-10-system-transaction-command-runtime.md`。
- 本计划不扩展 story snapshot，也不实现任何具体世界 System module。

## 文件结构

- 创建：`src/tools/state/commit-turn.ts`
  - LLM-facing operation schema、Pi adapter、receipt/error result。
- 创建：`src/systems/status.ts`
  - 把公开 `SystemProjection[]` 格式化为 GM/Writer 可读文本。
- 创建：`src/state/new-game.ts`
  - 在一个 setup transaction 中创建 core + System state，再更新 hot state。
- 修改：`src/tools/runtime/result.ts`
  - 增加不终止 GM 的结构化 `fail()` helper。
- 修改：`src/tools/state/context.ts`
  - Domain context 增加 `systemRuntime`。
- 修改：`src/tools/state/initialize-new-game.ts`
  - 通过 `new-game.ts` 初始化 core + 全部 namespace。
- 修改：`src/tools/state/get-status.ts`
  - 聚合 core status 与 GM audience projection。
- 修改：`src/tools/registry.ts`
  - 注册 `commit_turn`，绑定 `systemRuntime`，激活 session save。
- 修改：`src/state/active-save.ts`
  - System lifecycle 成功后再 hydrate core、设置 env、materialize roles。
- 修改：`src/commands/context.ts`
- 修改：`src/commands/registry.ts`
- 修改：`src/commands/load.ts`
- 修改：`src/commands/status.ts`
  - Slash command 加载/状态路径使用同一 lifecycle/projection。
- 修改：`src/runtime/writer-tools.ts`
- 修改：`extensions/core.ts`
- 修改：`extensions/two-pass-render/index.ts`
  - 共享同一个 `systemRuntime`，Writer 只获得 projection。
- 修改：`worlds/border-station/prompts/gm-tools.md`
  - 说明 `commit_turn` 与 `submit_direction_packet` 的分离。
- 修改：`worlds/border-station/prompts/gm-output.md`
  - 区分 core `update_*` 与 System `commit_turn`，避免与 `gm-tools.md` 冲突。
- 修改：`worlds/_template/prompts/gm.md`
- 修改：`skills/start-game/SKILL.md`
- 修改：`skills/build-rp-agent/SKILL.md`
- 修改：`skills/build-rp-agent/references/build-flow.md`
- 修改：`docs/demo.md`
  - 同步所有会指导 GM 或项目作者的旧 `update_*` 独占表述。
- 修改：`skills/development-guide/references/world-pack.md`
  - 把“后续工具”改为真实 operation 用法。
- 创建测试：`test/state/commit-turn.test.ts`
- 创建测试：`test/state/new-game-systems.test.ts`
- 创建测试：`test/systems/status.test.ts`
- 修改测试：`test/state/tools.test.ts`
- 修改测试：`test/commands/load.test.ts`
- 修改测试：`test/commands/status.test.ts`
- 修改测试：`test/runtime/writer-tools.test.ts`
- 修改测试：`test/runtime/extension-runtime.test.ts`
- 修改测试：`test/guards/turn-boundary.test.ts`
- 修改测试：`test/guards/tool-contract.test.ts`

## 任务 1：先更新回合边界 Guard

**文件：**

- 修改：`test/guards/turn-boundary.test.ts`
- 修改：`test/guards/tool-contract.test.ts`

- [ ] **步骤 1：把审批前负断言改为目标正断言**

```ts
test("commit_turn advances state without owning presentation handoff", () => {
  const commit = registered.find((tool) => tool.name === "commit_turn");
  assert.ok(commit);
  assert.deepEqual(Object.keys(commit.parameters.properties ?? {}), ["operations"]);
  assert.doesNotMatch(JSON.stringify(commit.parameters), /direction|events|summary/);

  const submit = registered.find((tool) => tool.name === "submit_direction_packet");
  assert.ok(submit);
});
```

`test/guards/tool-contract.test.ts` 的 module 列表加入 `src/tools/state/commit-turn.ts`。

- [ ] **步骤 2：运行 guard 并确认红灯**

```bash
npm test -- test/guards/turn-boundary.test.ts test/guards/tool-contract.test.ts
```

预期：FAIL，`commit_turn` 尚未注册/文件不存在。

- [ ] **步骤 3：暂不改生产代码，提交测试与后续任务一起完成**

本任务保持红灯，不单独 commit；任务 2 绿灯后一起提交。

## 任务 2：实现窄 `commit_turn` Tool

**文件：**

- 创建：`src/tools/state/commit-turn.ts`
- 修改：`src/tools/runtime/result.ts`
- 修改：`src/tools/state/context.ts`
- 修改：`src/tools/registry.ts`
- 创建测试：`test/state/commit-turn.test.ts`
- 修改测试：`test/guards/turn-boundary.test.ts`
- 修改测试：`test/guards/tool-contract.test.ts`

- [ ] **步骤 1：编写 direct tool 红灯测试**

```ts
const result = await commitTurnTool.execute(
  "call-17",
  {
    operations: [
      { system: "progression", command: "gain_xp", input: { amount: 25 } }
    ]
  },
  undefined,
  undefined,
  { ...context, piSessionId: "session-a" } as never
);

assert.equal(result.terminate, undefined);
assert.equal(result.details.ok, true);
assert.equal(result.details.requestId, seenRuntimeRequest.requestId);
assert.notEqual(result.details.requestId, "call-17");
assert.equal(result.details.revision, 1);
assert.equal(result.details.branchEpoch, 0);
```

另外断言 runtime request 收到 adapter 注入的 `saveId`、`caller={ kind: "gm", sessionId: "session-a" }` 和稳定摘要 requestId，System handler 不收到 Pi context。

使用相同 sessionId/toolCallId 调用 2 次，requestId 必须相同；改为 `session-b` 且保留 `call-17` 时，requestId 必须不同。摘要输入使用带类型标签的 canonical tuple，例如 `["pi-tool", sessionId, toolCallId]`，不得用可碰撞的字符串拼接。

- [ ] **步骤 2：编写输入和领域失败测试**

覆盖：

- `operations` 缺失、非数组或空数组。
- operation 缺少 system/command/input。
- 没有 active save。
- 没有可信 `piSessionId`。
- Runtime 返回 `COMMAND_INPUT_INVALID` 或 `STATE_COMMIT_CONFLICT`。

已知 `SystemRuntimeError` 转为：

```ts
{
  content: [{ type: "text", text: "State commit failed [COMMAND_INPUT_INVALID] ..." }],
  details: { ok: false, error: { code, context } }
}
```

不得设置 `terminate`。未知 programmer error 继续抛出，不伪装成领域拒绝。

- [ ] **步骤 3：运行测试确认红灯**

```bash
npm test -- test/state/commit-turn.test.ts test/guards/turn-boundary.test.ts test/guards/tool-contract.test.ts
```

- [ ] **步骤 4：实现 tool schema 和 adapter**

```ts
parameters: {
  type: "object",
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["system", "command", "input"],
        properties: {
          system: { type: "string" },
          command: { type: "string" },
          input: {}
        }
      }
    }
  }
}
```

遵循现有“入口宽”guard，不设置 `additionalProperties: false`；核心 runtime/parser 负责严格校验。

Request scope 使用固定实现，不在调用点手写拼接：

```ts
import { createHash } from "node:crypto";

function createScopedRequestId(sessionId: string, toolCallId: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["pi-tool", sessionId, toolCallId]))
    .digest("hex");
}
```

调用 runtime 时固定注入：

```ts
await context.systemRuntime.commit({
  saveId,
  requestId: createScopedRequestId(context.piSessionId, toolCallId),
  caller: { kind: "gm", sessionId: context.piSessionId },
  operations
});
```

`requestId` 可以出现在结构化 details 中用于诊断，但不得返回原始 sessionId。Branch epoch 由 runtime 从数据库读取，不由 adapter 或 LLM 提供。

- [ ] **步骤 5：注册到 `core.state`**

把 `commitTurnTool` 加入 `stateTools`。`bindToolContext()` 继续先从真实 Pi context 解析 session、激活 save，再传入 domain context。

- [ ] **步骤 6：验证红绿转换并提交**

```bash
npm test -- test/state/commit-turn.test.ts test/guards/turn-boundary.test.ts test/guards/tool-contract.test.ts
npm run typecheck
git add src/tools/state/commit-turn.ts src/tools/runtime/result.ts src/tools/state/context.ts src/tools/registry.ts test/state/commit-turn.test.ts test/guards/turn-boundary.test.ts test/guards/tool-contract.test.ts
git commit -m "feat(system): bind GM commit turn tool"
```

## 任务 3：原子初始化 Core 与 System State

**文件：**

- 创建：`src/state/new-game.ts`
- 修改：`src/systems/activation.ts`
- 修改：`src/tools/state/initialize-new-game.ts`
- 创建测试：`test/state/new-game-systems.test.ts`
- 修改测试：`test/state/tools.test.ts`

- [ ] **步骤 1：编写成功和失败红灯测试**

成功断言同一个新 save 同时存在：

- `latest_states` core payload。
- registry 中每个 `system_states` namespace。
- `system_save_revisions` 为 `{ revision: 0, branch_epoch: 0 }`。
- session binding。

失败测试让第二个 System `initialize()` 抛错，随后断言 `saves`、`latest_states`、`system_states`、commit metadata、receipt 和 session binding 都没有该 save 的残留行。

- [ ] **步骤 2：运行测试确认红灯**

```bash
npm test -- test/state/new-game-systems.test.ts test/state/tools.test.ts
```

- [ ] **步骤 3：抽取 in-transaction lifecycle helper**

在 `src/systems/activation.ts` 提供仅供 core orchestration 使用的 `activateSystemSaveInTransaction()`；原 `activateSystemSave()` 仍是自己包事务的 public lifecycle facade。两者共享同一 candidate/migration implementation，不复制逻辑。

- [ ] **步骤 4：实现 `createNewGame()`**

```text
BEGIN IMMEDIATE
-> INSERT saves
-> write core latest state
-> activateSystemSaveInTransaction
-> ensure revision 0 + branch epoch 0
-> bind session
-> COMMIT
-> hydrate StateStore hot state
-> project dynamic roles
```

失败先 `ROLLBACK`，hot state 不切换。

- [ ] **步骤 5：让 initialize tool 调用 orchestration**

保留现有参数 normalization 和 ToolResult 文案，只替换持久化编排。

- [ ] **步骤 6：验证并提交**

```bash
npm test -- test/state/new-game-systems.test.ts test/state/tools.test.ts
npm run typecheck
git add src/state/new-game.ts src/systems/activation.ts src/tools/state/initialize-new-game.ts test/state/new-game-systems.test.ts test/state/tools.test.ts
git commit -m "feat(system): initialize systems with new saves"
```

## 任务 4：在所有 Save Activation 路径绑定 Lifecycle

**文件：**

- 修改：`src/state/active-save.ts`
- 修改：`src/commands/context.ts`
- 修改：`src/commands/registry.ts`
- 修改：`src/commands/load.ts`
- 修改：`src/tools/registry.ts`
- 修改：`extensions/core.ts`
- 修改测试：`test/commands/load.test.ts`
- 修改测试：`test/state/tools.test.ts`
- 修改测试：`test/runtime/extension-runtime.test.ts`

- [ ] **步骤 1：编写 load migration 红灯测试**

准备已有 save：core state + progression v1。通过 `/load` 选择后断言：

- v1 原子迁移为 v2。
- core StateStore 激活该 save。
- migration 失败时 `/load` 报错，原 v1 payload 保留，core hot state 与原 session binding 都不切换。

- [ ] **步骤 2：运行测试确认红灯**

```bash
npm test -- test/commands/load.test.ts test/state/tools.test.ts test/runtime/extension-runtime.test.ts
```

- [ ] **步骤 3：修改 `activateSave()` 顺序**

```text
systemRuntime.activateSave(saveId)
-> stateStore.hydrateSave(saveId)
-> RP_ACTIVE_SAVE
-> materializeDynamicRoles
-> /load only: bindSessionToSave(piSessionId, saveId)
```

`/load` 选择目标 save 后不得提前 bind；只有上述 activation 全部成功才更新 session binding。System activation 失败时不得改变 env、hot core state、role projection 或原 session binding。第四份计划会在 system activation 与 core hydrate 之间插入 legacy snapshot 升级基线。

- [ ] **步骤 4：把 shared runtime 传入所有 adapter context**

- `extensions/core.ts` 从 infrastructure 解构 `systemRuntime`。
- `StateToolContext`、`CommandContext` 和 registry base context 都包含同一个实例。
- `before_agent_start`、每次 tool hydrate、`/load`、`/status` 使用同一 `activateSave()`。

- [ ] **步骤 5：验证并提交**

```bash
npm test -- test/commands/load.test.ts test/state/tools.test.ts test/runtime/extension-runtime.test.ts
npm run typecheck
git add src/state/active-save.ts src/commands/context.ts src/commands/registry.ts src/commands/load.ts src/tools/registry.ts extensions/core.ts test/commands/load.test.ts test/state/tools.test.ts test/runtime/extension-runtime.test.ts
git commit -m "feat(system): activate modules with saves"
```

## 任务 5：把 Projection 接入 GM、Slash Status 与 Writer

**文件：**

- 创建：`src/systems/status.ts`
- 修改：`src/tools/state/get-status.ts`
- 修改：`src/commands/status.ts`
- 修改：`src/runtime/writer-tools.ts`
- 修改：`extensions/two-pass-render/index.ts`
- 创建测试：`test/systems/status.test.ts`
- 修改测试：`test/commands/status.test.ts`
- 修改测试：`test/runtime/writer-tools.test.ts`
- 修改测试：`test/state/get-status.test.ts`

- [ ] **步骤 1：编写 projection 格式红灯测试**

```ts
assert.equal(
  formatSystemProjections([
    { system: "progression", revision: 3, value: { level: 2, xp: 75 } }
  ]),
  ["系统状态：", "- progression (revision 3): {\"level\":2,\"xp\":75}"].join("\n")
);
```

Formatter 只处理公开 value，不读取 repository。

- [ ] **步骤 2：编写 audience 测试**

- GM `get_status` 调用 `project(... audience: { kind: "gm" })`。
- Writer 的只读 `get_status` 调用 `audience: { kind: "writer" }`。
- `/status` 使用 GM audience。
- 原始 `payload_json` 不出现在 ToolResult details。

- [ ] **步骤 3：运行测试确认红灯**

```bash
npm test -- test/systems/status.test.ts test/commands/status.test.ts test/runtime/writer-tools.test.ts test/state/get-status.test.ts
```

- [ ] **步骤 4：聚合 core status 与 projections**

`get_status` 可以变为 async ToolDefinition；返回文本为 `formatStatus(core)`，有 projection 时追加空行和 `formatSystemProjections()`。`details` 只包含 projection 的公开 value。

- [ ] **步骤 5：验证并提交**

```bash
npm test -- test/systems/status.test.ts test/commands/status.test.ts test/runtime/writer-tools.test.ts test/state/get-status.test.ts
npm run typecheck
git add src/systems/status.ts src/tools/state/get-status.ts src/commands/status.ts src/runtime/writer-tools.ts extensions/two-pass-render/index.ts test/systems/status.test.ts test/commands/status.test.ts test/runtime/writer-tools.test.ts test/state/get-status.test.ts
git commit -m "feat(system): expose module projections"
```

## 任务 6：更新 GM 指引并做真实 Pi Contract 验证

**文件：**

- 修改：`worlds/border-station/prompts/gm-tools.md`
- 修改：`worlds/border-station/prompts/gm-output.md`
- 修改：`worlds/_template/prompts/gm.md`
- 修改：`skills/start-game/SKILL.md`
- 修改：`skills/build-rp-agent/SKILL.md`
- 修改：`skills/build-rp-agent/references/build-flow.md`
- 修改：`skills/development-guide/references/world-pack.md`
- 修改：`docs/demo.md`
- 修改测试：`test/runtime/extension-runtime.test.ts`
- 修改测试：`test/guards/turn-boundary.test.ts`

- [ ] **步骤 1：添加 extension registration 测试**

通过 `activateAllExtensions()` 收集 tools，断言：

- `commit_turn` 与 `submit_direction_packet` 同时存在。
- `commit_turn.execute(...)` 成功结果没有 `terminate`。
- `submit_direction_packet(needsRender=true)` 仍返回 `terminate: true`。
- 连续调用 2 次 `commit_turn` 时 GM tool loop 不结束，revision 递增。

- [ ] **步骤 2：更新 GM prompt**

删除“等待新的扩展能力设计”和“所有确定性状态只走 `update_*`”等独占表述。所有入口统一明确：

```text
- Core player/time/scene/attributes 变化使用对应 update_* 工具。
- System module state 变化使用 commit_turn operations；同一 GM 流程可调用多次。
- commit_turn 只推进状态，之后仍须单独调用 submit_direction_packet 完成展示交接。
- 不把 direction、events 或终止意图放进 commit_turn。
```

`worlds/border-station/prompts.yaml` 会同时注入 `gm-tools.md` 与 `gm-output.md`，两者必须使用同一分工。`test/guards/turn-boundary.test.ts` 读取上述世界提示词、模板、启动/构建 skills 和 `docs/demo.md`，断言每个入口同时保留 core `update_*` 与 System `commit_turn`，不得再次出现二者互斥的说明。

- [ ] **步骤 3：运行边界与全量验证**

```bash
npm test -- test/state/commit-turn.test.ts test/guards/turn-boundary.test.ts test/guards/tool-contract.test.ts test/runtime/extension-runtime.test.ts
npm run typecheck
npm test
git diff --check
```

- [ ] **步骤 4：提交**

```bash
git add worlds/border-station/prompts/gm-tools.md worlds/border-station/prompts/gm-output.md worlds/_template/prompts/gm.md skills/start-game/SKILL.md skills/build-rp-agent/SKILL.md skills/build-rp-agent/references/build-flow.md skills/development-guide/references/world-pack.md docs/demo.md test/runtime/extension-runtime.test.ts test/guards/turn-boundary.test.ts
git commit -m "docs(system): teach separate state commits"
```

## 完成条件

- GM 可通过真实 Pi tool contract 调用 `commit_turn`。
- Tool input 只有 operations；receipt/error 结构化；`terminate` 不存在。
- Adapter 使用 sessionId/toolCallId 的稳定摘要作为 requestId，并注入可信 GM caller；不同 session 的相同 toolCallId 不冲突。
- `submit_direction_packet` 仍是唯一展示交接和 GM 终止工具。
- 新建、加载、每轮启动和 tool hydration 都先完成 System activation。
- GM 与 Writer 只读取 projection，不读取 `system_states.payload_json`。
- Writer 失败不在本计划内回滚任何已成功 State commit。
- 所有活动提示词和项目生成指南都明确区分 core `update_*` 与 System `commit_turn`。
- 本计划没有修改 story snapshot 主体或 `/roll` 语义。
