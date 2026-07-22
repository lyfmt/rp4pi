# RP Live 链路修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复真实 Pi 运行时中 `writer render -> turn_committed hooks -> OpenViking memory append` 未打通的问题，并让 live smoke 能准确验证完整链路。

**架构：** 当前失败点不是 GM、state tools 或 writer，而是跨扩展事件广播。保留现有 `turn-events` 抽象，但把 listener 存储从模块级变量迁移到进程级共享 registry，并在扩展卸载时清理订阅，保证 Pi 使用 `jiti` 且 `moduleCache: false` 时多个 `-e` 扩展仍共享同一个事件通道。

**技术栈：** TypeScript、Pi extension API、Node.js `node:test`、SQLite、OpenViking、shell smoke script。

---

## 问题陈述

当前项目的 RP MVP 已经能跑到以下链路：

```text
玩家输入
  -> Pi GM agent
  -> initialize_new_game / update_* state tools
  -> submit_direction_packet
  -> two-pass writer render
  -> turn_snapshots 写入 SQLite
```

但真实 Pi live 测试没有跑通后半段：

```text
writer render
  -> emit turn-rendered
  -> core turn_committed hooks
  -> OpenViking memory append/commit
```

直接表现：

| 观察项 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 47/47 通过 |
| `bash scripts/smoke-demo.sh` | 静态检查通过 |
| OpenViking health | 可达，`auth_mode: dev` |
| OpenViking append+commit 独立 smoke | task 最终完成，提取 9 条记忆变更 |
| Pi live 新游戏 | exit 0，创建 save 和 `turn_snapshots` |
| Pi live 回合后的 `hook_fire_state` | 0 |
| Pi live 回合后的 `ov_session_bindings` | 0 |
| Pi live 回合后的 `latest_states.time.hour` | 仍为 7，未被 `clock-drift` 推进 |

这说明问题不在 OpenViking HTTP client 本身，也不在 writer 生成正文。问题集中在 `turn-rendered` 事件没有跨扩展送达。

## 根因判断

项目当前用 [src/runtime/turn-events.ts](../../../src/runtime/turn-events.ts) 的模块级 `Set` 保存 listener：

```ts
const listeners = new Set<TurnRenderedListener>();
```

三个扩展分别依赖它：

| 扩展 | 角色 |
| --- | --- |
| [extensions/two-pass-render/index.ts](../../../extensions/two-pass-render/index.ts) | 渲染完成后 `emitTurnRendered` |
| [extensions/core.ts](../../../extensions/core.ts) | 监听后触发 `turn_committed` hooks |
| [extensions/openviking-memory/index.ts](../../../extensions/openviking-memory/index.ts) | 监听后 append/commit OV memory |

真实 Pi extension loader 使用 `jiti` 加载 TypeScript 扩展，并配置：

```ts
moduleCache: false
```

结果是每个 `-e` 扩展加载到各自的模块实例中。`turn-events.ts` 的模块级 `listeners` 在单元测试中是共享的，但在真实 Pi live 中不是共享的。

因此：

```text
two-pass-render emit 的是实例 A 的 listeners
core / openviking-memory 订阅的是实例 B/C 的 listeners
事件没有送达
```

## 文件结构

修改：

```text
src/runtime/turn-events.ts
extensions/core.ts
extensions/openviking-memory/index.ts
test/helpers/extensions.ts
```

创建：

```text
test/runtime/turn-events.test.ts
```

可能修改：

```text
scripts/smoke-demo-live.sh
README.md
docs/demo.md
```

## 设计约束

- 保留 `emitTurnRendered` / `onTurnRendered` 的 await 语义，避免把 OV append 改成不可等待的 fire-and-forget。
- 不把 OpenViking 逻辑塞回 two-pass-render，保持「渲染」「hooks」「长期记忆」三个扩展的边界。
- 订阅必须能跨 `jiti moduleCache: false` 的多个模块实例共享。
- 扩展 reload 或 session shutdown 时必须能清理旧 listener，避免重复触发。
- `turn_committed` hook 失败不能打断 story commit。
- OpenViking 失败仍只发送 memory-error notice，不回滚 SQLite story snapshot。

## 推荐方案

把 `turn-events.ts` 的 listener registry 放到 `globalThis` 上，并用 `Symbol.for` 作为稳定 key：

```ts
const TURN_EVENTS_KEY = Symbol.for("my-rp-agent.turn-events");
```

这样即使 `turn-events.ts` 被 `jiti` 加载成多个模块实例，也能共享同一个进程级 registry。

同时让 `onTurnRendered` 返回 unsubscribe，并在扩展里注册 `session_shutdown` 清理：

```ts
const unsubscribe = onTurnRendered(listener);
pi.on("session_shutdown", unsubscribe);
```

## 任务 1：写出跨模块实例失败测试

**文件：**

- 创建：`test/runtime/turn-events.test.ts`

- [ ] **步骤 1：编写失败测试**

用带 query 的动态 import 模拟同一个文件被加载成两个模块实例：

```ts
const producer = await import(`${turnEventsUrl}?producer=${Date.now()}`);
const consumer = await import(`${turnEventsUrl}?consumer=${Date.now()}`);
```

测试行为：

```text
consumer.onTurnRendered(listener)
producer.emitTurnRendered(event)
listener 必须收到 event
```

- [ ] **步骤 2：运行测试验证失败**

```bash
node --test test/runtime/turn-events.test.ts
```

预期：当前实现失败，listener 收不到事件。

## 任务 2：实现进程级 turn event registry

**文件：**

- 修改：`src/runtime/turn-events.ts`

- [ ] **步骤 1：把模块级 Set 改成 global registry**

实现要点：

```ts
type TurnEventRegistry = {
  listeners: Set<TurnRenderedListener>;
};
```

读取 registry：

```ts
function getRegistry(): TurnEventRegistry {
  const global = globalThis as typeof globalThis & {
    [TURN_EVENTS_KEY]?: TurnEventRegistry;
  };
  global[TURN_EVENTS_KEY] ??= { listeners: new Set() };
  return global[TURN_EVENTS_KEY];
}
```

- [ ] **步骤 2：保留现有 API**

`onTurnRendered`、`emitTurnRendered`、`resetTurnListenersForTest` 的调用方不应大规模改动。

- [ ] **步骤 3：运行新增测试**

```bash
node --test test/runtime/turn-events.test.ts
```

预期：通过。

## 任务 3：补扩展卸载清理

**文件：**

- 修改：`extensions/core.ts`
- 修改：`extensions/openviking-memory/index.ts`

- [ ] **步骤 1：保存 unsubscribe**

在两个订阅点改成：

```ts
const unsubscribe = onTurnRendered(...);
pi.on("session_shutdown", unsubscribe);
```

- [ ] **步骤 2：补类型兼容**

当前 [src/types/pi.ts](../../../src/types/pi.ts) 已有泛型 `pi.on(event: string, ...)`，理论上不用改。若 TypeScript 报错，再添加明确的 `session_shutdown` overload。

- [ ] **步骤 3：运行相关测试**

```bash
node --test test/runtime/extension-runtime.test.ts test/e2e/demo-flow.test.ts
npm run typecheck
```

预期：通过。

## 任务 4：验证 hooks 端到端恢复

**文件：**

- 修改：`test/e2e/demo-flow.test.ts`（如现有断言不足再补）

- [ ] **步骤 1：确认 e2e 已覆盖 `clock-drift`**

现有 e2e 已断言：

```text
snapshot time.hour = 9
latest state time.hour = 10
```

这能证明：

```text
agent_end -> writer render -> emit turn-rendered -> turn_committed hook
```

- [ ] **步骤 2：运行 e2e**

```bash
node --test test/e2e/demo-flow.test.ts
```

预期：通过。

## 任务 5：验证 OpenViking listener 恢复

**文件：**

- 修改：`test/runtime/extension-runtime.test.ts`（如需要）

- [ ] **步骤 1：确认 OV failure 测试仍覆盖 listener**

现有测试 `extension surfaces OpenViking append failures as memory error messages` 应继续证明：

```text
turn-rendered event
  -> openviking-memory listener
  -> appendTurnToMemory
  -> failure notice
```

- [ ] **步骤 2：补一个成功路径断言**

如果现有测试只覆盖失败 notice，新增 fake OV client 成功路径，断言 `ov_session_bindings` 写入。

推荐断言：

```sql
SELECT COUNT(*) FROM ov_session_bindings
```

预期：等于 1。

- [ ] **步骤 3：运行测试**

```bash
node --test test/runtime/extension-runtime.test.ts
```

预期：通过。

## 任务 6：修正 live smoke 对 OpenViking 慢 task 的误判

**文件：**

- 修改：`scripts/smoke-demo-live.sh`
- 可能修改：`README.md`
- 可能修改：`docs/demo.md`

- [ ] **步骤 1：陈述当前误判**

本次真实记录：

```text
session_commit task 约 136 秒后 completed
脚本只轮询 120 秒
脚本报 failed，但 task 后来完成并提取 memory_write: 8、memory_edit: 1
```

- [ ] **步骤 2：调高轮询窗口**

把最大尝试从 120 调整到 240，仍保持 1 秒间隔。

```bash
for (let attempt = 0; attempt < 240; attempt += 1) {
  ...
}
```

- [ ] **步骤 3：改善失败信息**

失败时输出：

```text
task_id
status
created_at_iso
updated_at_iso
elapsed seconds
```

这样可以区分真正失败和后台任务偏慢。

- [ ] **步骤 4：运行脚本**

```bash
bash scripts/smoke-demo-live.sh
```

预期：

```text
PASS OpenViking health check
PASS OpenViking append+commit memory smoke
```

## 任务 7：真实 Pi live 回归

**文件：**

- 不一定修改代码；使用临时 SQLite 验证。

- [ ] **步骤 1：运行隔离 live 回合**

```bash
timeout 300s env RP_SQLITE_PATH=/tmp/rp-agent-live-smoke.sqlite ./start.sh --approve --session-id codex-live-smoke-fixed -p "开始新游戏，使用默认 demo 世界。"
```

预期：exit 0。

- [ ] **步骤 2：检查 SQLite 结果**

运行：

```bash
node --input-type=module <<'NODE'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/tmp/rp-agent-live-smoke.sqlite");
console.log({
  saves: db.prepare("SELECT COUNT(*) AS n FROM saves").get().n,
  snapshots: db.prepare("SELECT COUNT(*) AS n FROM turn_snapshots").get().n,
  hookFireState: db.prepare("SELECT COUNT(*) AS n FROM hook_fire_state").get().n,
  ovBindings: db.prepare("SELECT COUNT(*) AS n FROM ov_session_bindings").get().n,
  latest: db.prepare("SELECT state_json FROM latest_states LIMIT 1").get()
});
db.close();
NODE
```

预期：

```text
saves = 1
snapshots = 1
hookFireState >= 1
ovBindings = 1
latest state time.hour = 8
```

说明：

```text
writer render 已完成
clock-drift 已触发
OpenViking append 已创建 save 绑定
```

## 任务 8：最终验证

- [ ] **步骤 1：运行 typecheck**

```bash
npm run typecheck
```

预期：exit 0。

- [ ] **步骤 2：运行全量测试**

```bash
npm test
```

预期：全部通过。

- [ ] **步骤 3：运行主 smoke**

```bash
bash scripts/smoke-demo.sh
```

预期：

```text
RUN npm run typecheck
RUN npm test
PASS start.sh is executable
PASS OpenViking append+commit memory smoke
```

如果 OpenViking 服务不可达，可以接受 `SKIP live OpenViking smoke`，但不能声称 live OV 已通过。

## 验收标准

- [ ] `turn-events` 新增跨模块实例测试通过。
- [ ] `test/e2e/demo-flow.test.ts` 证明 `turn_committed` hook 仍端到端触发。
- [ ] `test/runtime/extension-runtime.test.ts` 证明 OpenViking listener 能收到 rendered turn。
- [ ] 真实 Pi live 回合后，临时 SQLite 中 `hook_fire_state > 0`。
- [ ] 真实 Pi live 回合后，临时 SQLite 中 `ov_session_bindings = 1`。
- [ ] `bash scripts/smoke-demo-live.sh` 在 OV 可达时能等到 task completed。
- [ ] `npm run typecheck` 通过。
- [ ] `npm test` 通过。

## 风险与注意事项

| 风险 | 处理 |
| --- | --- |
| global registry 在 reload 后残留 listener | 每个订阅方用 `session_shutdown` 清理 unsubscribe |
| 多次 activate 导致重复 listener | 测试中继续使用 `resetTurnListenersForTest`；真实扩展靠 shutdown 清理 |
| OpenViking task 慢于脚本窗口 | 调高轮询窗口，并输出 task 诊断信息 |
| `-p` 非交互模式不显示 writer prose | 以 SQLite snapshot、hook state、OV binding 作为验证依据，不把 stdout 作为唯一信号 |

## 不在本计划内

- 不重构 writer prompt。
- 不改变世界包 schema。
- 不改变 OpenViking memory schema。
- 不实现 hook 的自主 subagent spawn；`delegate` 仍保持当前 MVP 语义。
