# System Story Snapshot、Restore 与 `/roll` 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:test-driven-development、superpowers:systematic-debugging（遇到现有 roll 测试语义冲突时）和 superpowers:executing-plans。若调度子代理，必须显式设置项目允许的 `model` 与 `reasoning_effort=medium`；工具不能同时设置时禁止调度。

**目标：** 把 story snapshot 扩展为完整确定性恢复 envelope，在 Pi 接受正文投递后捕获它，并让 `/roll` 原子恢复核心、全部 System state、dynamic roles 和 trajectory，同时维护可替换的 active story chain 与单调分支元数据。

**架构：** Snapshot 继续存入 SQLite `turn_snapshots.state_json`，但内容升级为带 `schemaVersion` 的 envelope。Existing save activation 先把最新 core-only row 提升为当前完整状态的升级基线。Restore 在 `BEGIN IMMEDIATE` 内完成兼容性预检、System migration、participant 替换、revision/branch epoch 推进和最新 snapshot supersede；正文投递 completion 只在 `sendMessage` 返回且未抛错后捕获 envelope。

**技术栈：** TypeScript、Node 24、`node:sqlite`、Node test runner、现有 two-pass runtime 与 slash command wiring。

---

## 前置条件

- 已完成 registry/persistence、transaction runtime 和 GM tool binding 3 份 P1 计划。
- `SystemRuntime` 可以 activate/project/commit，`SystemRegistry` 和 repository 可读取 versioned opaque payload。
- 本计划不实现 RNG/jobs/audit/visibility adapter；envelope 为未来 capability participant 保留空 map。

## 文件结构

- 创建：`src/state/snapshot-envelope.ts`
  - 定义/解析 `StorySnapshotEnvelope`，严格拒绝 legacy core-only row。
- 创建：`src/state/trajectory-snapshot.ts`
  - 捕获 per-character watermark + summary，原子恢复 trajectory participant。
- 创建：`src/state/story-snapshot-coordinator.ts`
  - 深 interface：capture、preflight/restore、supersede active latest。
- 修改：`src/state/snapshots.ts`
  - 保留 turn number 查询，委托新 coordinator；逐步移除 core-only helper。
- 修改：`src/state/active-save.ts`
  - System activation 后、hot state 切换前建立 legacy 升级基线。
- 修改：`src/state/dynamic-roles.ts`
  - 增加 transaction-safe `replaceDynamicRoles()`。
- 修改：`src/systems/repository.ts`
  - 增加 exact namespace replacement helpers。
- 修改：`src/systems/activation.ts`
  - 复用 migration/parse candidate 逻辑处理 snapshot payload，不复制规则。
- 修改：`src/systems/runtime.ts`
  - Restore 后丢弃旧 ready cache 并重新 activate。
- 修改：`src/systems/commit-repository.ts`
  - Restore transaction 推进 revision 与 branch epoch。
- 修改：`src/runtime/bootstrap.ts`
  - 构造共享 `storySnapshots` coordinator。
- 修改：`src/runtime/turn-commit.ts`
  - 返回 delivery completion；Pi 接受正文投递后捕获完整 envelope。
- 修改：`src/runtime/turn-hook.ts`
- 修改：`src/runtime/idle-delivery.ts`
  - 返回可观察的投递 Promise，失败时不再静默吞掉。
- 修改：`src/tools/state/context.ts`
- 修改：`src/tools/registry.ts`
  - 把共享 coordinator 传入每次 save activation。
- 修改：`extensions/core.ts`
- 修改：`extensions/two-pass-render/index.ts`
  - 传递 coordinator。
- 修改：`src/commands/context.ts`
- 修改：`src/commands/registry.ts`
- 修改：`src/commands/load.ts`
- 修改：`src/commands/roll.ts`
  - 使用 atomic restore + active chain semantics。
- 修改：`src/world/materialize-dynamic-roles.ts`
  - Restore 后强制重新投影当前 save roles（复用现有 invalidation）。
- 创建测试：`test/state/snapshot-envelope.test.ts`
- 创建测试：`test/state/trajectory-snapshot.test.ts`
- 创建测试：`test/state/story-snapshot-coordinator.test.ts`
- 修改测试：`test/state/dynamic-roles.test.ts`
- 修改测试：`test/state/sqlite.test.ts`
- 修改测试：`test/runtime/turn-commit.test.ts`
- 创建测试：`test/runtime/idle-delivery.test.ts`
- 修改测试：`test/runtime/extension-runtime.test.ts`
- 修改测试：`test/commands/load.test.ts`
- 修改测试：`test/commands/roll.test.ts`
- 修改测试：`test/commands/extension-commands.test.ts`
- 修改测试：`test/state/tools.test.ts`
- 修改测试：`test/hooks/engine.test.ts`
- 修改测试：`test/subagents/role-runtime.test.ts`
- 修改测试：`test/world/hooks-border-station.test.ts`
- 修改测试：`test/e2e/demo-flow.test.ts`
- 修改测试：`test/helpers/extensions.ts`

## 任务 1：定义 Versioned Snapshot Envelope

**文件：**

- 创建：`src/state/snapshot-envelope.ts`
- 测试：`test/state/snapshot-envelope.test.ts`

- [ ] **步骤 1：编写合法 envelope 红灯测试**

```ts
const parsed = parseStorySnapshotEnvelope({
  schemaVersion: 1,
  core: { version: 1, payload: createInitialState() },
  systems: {
    progression: { version: 2, payload: { level: 2, xp: 50, perks: [] } }
  },
  dynamicRoles: [],
  trajectory: { watermarks: {}, summaries: [] },
  capabilities: {}
});
assert.equal(parsed.systems.progression?.version, 2);
```

- [ ] **步骤 2：编写严格失败测试**

拒绝：

- 缺失/未知 `schemaVersion`。
- 非法 core `RpState`。
- System version 非正整数。
- payload 不是 JSON-compatible value。
- 缺失 dynamicRoles/trajectory/capabilities participant。
- 直接传给 restore parser 的 legacy core-only `state_json`。

Legacy row 返回稳定 `SNAPSHOT_INCOMPATIBLE`；不得猜测补齐当时不存在的 dynamic roles/trajectory。任务 4 会在 existing save activation 时用当前完整确定性 state 建立升级基线。基线建立后只需再成功交付 1 个新故事回合即可 `/roll`。

- [ ] **步骤 3：运行测试确认红灯**

```bash
npm test -- test/state/snapshot-envelope.test.ts
```

- [ ] **步骤 4：实现 envelope types/parser**

```ts
export type StorySnapshotEnvelope = {
  schemaVersion: 1;
  core: { version: 1; payload: RpState };
  systems: Record<string, { version: number; payload: JsonValue }>;
  dynamicRoles: DynamicRole[];
  trajectory: TrajectorySnapshot;
  capabilities: Record<string, JsonValue>;
};
```

Parser 只验证 envelope/core/generic JSON 形状；System payload 的领域 parser 在 restore preflight 执行。Revision、branchEpoch 和 idempotency receipt 是单调运行时元数据，不进入 envelope。

- [ ] **步骤 5：验证并提交**

```bash
npm test -- test/state/snapshot-envelope.test.ts
npm run typecheck
git add src/state/snapshot-envelope.ts test/state/snapshot-envelope.test.ts
git commit -m "feat(snapshot): define deterministic envelope"
```

## 任务 2：捕获与恢复 Dynamic Roles、Trajectory

**文件：**

- 创建：`src/state/trajectory-snapshot.ts`
- 修改：`src/state/dynamic-roles.ts`
- 创建测试：`test/state/trajectory-snapshot.test.ts`
- 修改测试：`test/state/dynamic-roles.test.ts`

- [ ] **步骤 1：编写 dynamic roles replacement 红灯测试**

`replaceDynamicRoles(db, saveId, snapshotRoles)` 必须：删除 snapshot 中不存在的角色、恢复旧 persona/description/timestamps、保持其他 save 不变。

- [ ] **步骤 2：编写 trajectory capture 红灯测试**

```ts
const snapshot = captureTrajectorySnapshot(db, saveId);
assert.deepEqual(snapshot.watermarks, { "han-yue": 4 });
assert.equal(snapshot.summaries[0]?.coversUpToSeq, 2);
```

Watermark 是每个 character 当前 `MAX(seq)`；summary 完整保存在 envelope。

- [ ] **步骤 3：编写 trajectory restore 红灯测试**

在 capture 后追加：已有角色 seq 5、一个新角色 seq 1，并更新 summary。Restore 后：

- 删除已有角色 seq > 4。
- 删除 snapshot 不含的新角色全部 entries/summary。
- 精确替换 snapshot summaries。
- 若 snapshot summary `coversUpToSeq > watermark`，预检失败且不删除任何数据。

- [ ] **步骤 4：运行测试确认红灯**

```bash
npm test -- test/state/trajectory-snapshot.test.ts test/state/dynamic-roles.test.ts
```

- [ ] **步骤 5：实现 transaction-safe helpers**

Helpers 不自行 `BEGIN/COMMIT`，由 story snapshot coordinator 控制同一个事务。

- [ ] **步骤 6：验证并提交**

```bash
npm test -- test/state/trajectory-snapshot.test.ts test/state/dynamic-roles.test.ts
npm run typecheck
git add src/state/trajectory-snapshot.ts src/state/dynamic-roles.ts test/state/trajectory-snapshot.test.ts test/state/dynamic-roles.test.ts
git commit -m "feat(snapshot): capture roles and trajectories"
```

## 任务 3：捕获完整 Story Snapshot

**文件：**

- 创建：`src/state/story-snapshot-coordinator.ts`
- 修改：`src/state/snapshots.ts`
- 修改：`src/systems/repository.ts`
- 创建测试：`test/state/story-snapshot-coordinator.test.ts`
- 修改测试：`test/state/sqlite.test.ts`

- [ ] **步骤 1：编写 capture 红灯测试**

准备 core、2 个 System namespace、dynamic role 与 trajectory，调用：

```ts
const turnNo = coordinator.captureSuccessfulStory(saveId, coreState);
const row = readSnapshotRow(db, saveId, turnNo);
const envelope = parseStorySnapshotEnvelope(JSON.parse(row.stateJson));
```

断言 systems 按名称稳定排序，payload/version 与 `system_states` 一致，roles/trajectory 完整，capabilities 为 `{}`。

- [ ] **步骤 2：编写 namespace incomplete 失败测试**

Registry 有 `progression`，但 persisted state 缺失；capture 返回 `SNAPSHOT_INCOMPATIBLE`，不插入 turn snapshot。

- [ ] **步骤 3：运行测试确认红灯**

```bash
npm test -- test/state/story-snapshot-coordinator.test.ts test/state/sqlite.test.ts
```

- [ ] **步骤 4：实现 capture 与 retention**

Capture 使用一个短 SQLite transaction 读取确定性 participants 并插入 snapshot。继续按 save 保留 active chain 最近 2 个 snapshot。不要调用 System parser/project，复制的是 versioned opaque payload。

保留 `latestStorySnapshotTurnNo(db, saveId)` 供 Hook/role runtime 使用；把旧 `recordSuccessfulStorySnapshot()` 改为 coordinator 的兼容 wrapper，随后在任务 6 迁移生产调用点。

- [ ] **步骤 5：验证并提交**

```bash
npm test -- test/state/story-snapshot-coordinator.test.ts test/state/sqlite.test.ts
npm run typecheck
git add src/state/story-snapshot-coordinator.ts src/state/snapshots.ts src/systems/repository.ts test/state/story-snapshot-coordinator.test.ts test/state/sqlite.test.ts
git commit -m "feat(snapshot): capture all deterministic state"
```

## 任务 4：为 Existing Save 建立 Legacy 升级基线

**文件：**

- 修改：`src/state/story-snapshot-coordinator.ts`
- 修改：`src/state/snapshots.ts`
- 修改：`src/state/active-save.ts`
- 修改：`src/runtime/bootstrap.ts`
- 修改：`src/tools/state/context.ts`
- 修改：`src/tools/registry.ts`
- 修改：`src/commands/context.ts`
- 修改：`src/commands/registry.ts`
- 修改：`src/commands/load.ts`
- 修改：`extensions/core.ts`
- 修改：`extensions/two-pass-render/index.ts`
- 修改测试：`test/state/story-snapshot-coordinator.test.ts`
- 修改测试：`test/commands/load.test.ts`
- 修改测试：`test/state/tools.test.ts`
- 修改测试：`test/runtime/extension-runtime.test.ts`

- [ ] **步骤 1：编写升级基线红灯测试**

准备 existing save：`latest_states`、ready System namespace、dynamic roles、trajectory，以及 turn 4/5 两条 legacy core-only snapshot。调用：

```ts
const result = coordinator.promoteLegacySnapshotBaseline(saveId);
assert.deepEqual(result, { promoted: true, turnNo: 5 });
```

断言：

- Turn 5 保持同一 `(save_id, turn_no)`，`state_json` 被替换为完整 envelope，不新增 turn 6。
- Envelope 使用当前 `latest_states`、当前 System payload、dynamic roles 与 trajectory，不使用 legacy row 猜测旧参与者。
- 升级基线不计为新故事回合，不发布 `turn-rendered`，也不推进 revision/branch epoch。
- Turn 4 保持 legacy row；完成 1 个新故事 snapshot 后 retention 只保留升级基线与新 snapshot，此时 `/roll` 可恢复基线。
- Latest row 已是完整 envelope、save 没有 snapshot 时返回 `{ promoted: false }`，不写数据库。

- [ ] **步骤 2：编写失败与 activation 顺序红灯测试**

覆盖 System namespace 不完整、当前 core 非法、trajectory 非法和 SQLite 写入失败。失败时 legacy row、当前 state 与 hot `StateStore` 全部不变。

通过 `/load` 验证顺序：

```text
systemRuntime.activateSave(saveId)
-> storySnapshots.promoteLegacySnapshotBaseline(saveId)
-> stateStore.hydrateSave(saveId)
-> RP_ACTIVE_SAVE
-> materializeDynamicRoles
-> bind session
```

基线失败时不得切换 hot state、env、roles 或 session binding。System activation 已完成的独立合法 migration 可以保留；重试必须幂等。

- [ ] **步骤 3：运行测试确认红灯**

```bash
npm test -- test/state/story-snapshot-coordinator.test.ts test/commands/load.test.ts test/state/tools.test.ts test/runtime/extension-runtime.test.ts
```

- [ ] **步骤 4：实现原子升级基线与共享 wiring**

`promoteLegacySnapshotBaseline()` 在一个短 transaction 中重新确认 latest row 仍是 legacy、捕获当前全部 participant，并更新该 row 的 `state_json`。不得调用 System projection，也不得修改 revision、branch epoch 或 receipt。

`RuntimeInfrastructure` 增加共享 `storySnapshots`，并把它传给所有 save activation 入口。新 save 没有 legacy row，因此该步骤是无写入 no-op。

- [ ] **步骤 5：验证并提交**

```bash
npm test -- test/state/story-snapshot-coordinator.test.ts test/commands/load.test.ts test/state/tools.test.ts test/runtime/extension-runtime.test.ts
npm run typecheck
git add src/state/story-snapshot-coordinator.ts src/state/snapshots.ts src/state/active-save.ts src/runtime/bootstrap.ts src/tools/state/context.ts src/tools/registry.ts src/commands/context.ts src/commands/registry.ts src/commands/load.ts extensions/core.ts extensions/two-pass-render/index.ts test/state/story-snapshot-coordinator.test.ts test/commands/load.test.ts test/state/tools.test.ts test/runtime/extension-runtime.test.ts
git commit -m "feat(snapshot): promote legacy save baseline"
```

## 任务 5：实现兼容性预检与原子 Restore

**文件：**

- 修改：`src/state/story-snapshot-coordinator.ts`
- 修改：`src/systems/activation.ts`
- 修改：`src/systems/commit-repository.ts`
- 修改：`src/systems/repository.ts`
- 修改：`src/systems/runtime.ts`
- 修改测试：`test/state/story-snapshot-coordinator.test.ts`

- [ ] **步骤 1：编写 restore 成功红灯测试**

在 snapshot 后修改 core、2 个 System state、dynamic roles 和 trajectory，再调用：

```ts
const restored = coordinator.restorePreviousAndSupersedeLatest(saveId);
assert.equal(restored.restoredTurnNo, 1);
assert.equal(restored.supersededTurnNo, 2);
assert.equal(restored.revision, 3);
assert.equal(restored.branchEpoch, 1);
```

测试在 restore 前把 commit metadata 设为 `{ revision: 2, branchEpoch: 0 }`。断言所有 participant 恢复、turn 2 row 不再属于 active chain，并且 metadata 变为 `{ revision: 3, branchEpoch: 1 }`。

- [ ] **步骤 2：编写完整失败矩阵**

每个测试都在失败后重新读取 core/System/roles/trajectory/snapshot rows、revision、branch epoch 与 receipt，断言全部不变：

- Snapshot 含 registry 缺失 module。
- Snapshot System payload 是未来版本。
- Snapshot migration 抛错/结果非法。
- 当前 registry 新 module 不在 snapshot，`initialize()` 失败。
- Dynamic role 或 trajectory participant 非法。
- 第二个 System restore validation 失败。

- [ ] **步骤 3：编写 restore 后并发与幂等红灯测试**

覆盖：

- Restore 前读取 `expectedRevision: 2`；restore 成功后提交必须返回 `STATE_COMMIT_CONFLICT`。
- Branch 0 已有 `(requestId="call-1", batch=A)` 成功 receipt；restore 推进到 branch 1 后，同一 requestId/batch 不返回旧 receipt，而是执行新分支 command 并生成新 commitId。
- Branch 0 receipt 保留但只能通过显式 branch 0 repository 查询读取；runtime 永远只查当前 branch epoch。

- [ ] **步骤 4：编写新增 module 初始化测试**

Snapshot 只有 progression；当前 registry 新增 generator。Restore 时 progression 使用 snapshot payload，generator 在同一 transaction 以 current version initialize。

- [ ] **步骤 5：运行测试确认红灯**

```bash
npm test -- test/state/story-snapshot-coordinator.test.ts
```

- [ ] **步骤 6：复用 activation candidate logic**

把 `src/systems/activation.ts` 中“版本比较 -> migrate -> parse”抽成不写数据库的 internal function。Activation 与 restore 都调用它，防止两套 migration 规则漂移。

- [ ] **步骤 7：实现 restore transaction**

```text
BEGIN IMMEDIATE
-> read latest + predecessor snapshot
-> parse full target envelope
-> build/validate every System candidate
-> validate roles/trajectory
-> replace core latest state
-> replace exact System namespace set
-> replace roles/trajectory
-> advance revision + branchEpoch
-> DELETE superseded latest snapshot row
-> COMMIT
-> invalidate System runtime ready cache
```

任何写入前完成所有纯验证；数据库约束失败仍由 transaction 兜底。调用 `advanceSaveBranchMetadata()` 必须与 participant replacement 和 snapshot supersede 位于同一 transaction。不得回退或删除旧 branch receipt。

- [ ] **步骤 8：验证并提交**

```bash
npm test -- test/state/story-snapshot-coordinator.test.ts test/systems/activation.test.ts
npm run typecheck
git add src/state/story-snapshot-coordinator.ts src/systems/activation.ts src/systems/commit-repository.ts src/systems/repository.ts src/systems/runtime.ts test/state/story-snapshot-coordinator.test.ts
git commit -m "feat(snapshot): restore system state atomically"
```

## 任务 6：接入 Writer Story Commit

**文件：**

- 修改：`src/runtime/idle-delivery.ts`
- 修改：`src/runtime/turn-commit.ts`
- 修改：`src/runtime/turn-hook.ts`
- 修改：`extensions/two-pass-render/index.ts`
- 创建测试：`test/runtime/idle-delivery.test.ts`
- 修改测试：`test/runtime/turn-commit.test.ts`
- 修改测试：`test/runtime/extension-runtime.test.ts`
- 修改测试：`test/e2e/demo-flow.test.ts`

- [ ] **步骤 1：编写 idle 投递确认红灯测试**

`deliverWhenIdle()` 改为返回 `Promise<void>`。使用受控 `isIdle` 与 timer queue 覆盖：

- 首次 busy 时只登记 timer，Promise 保持 pending，`sendMessage` 尚未调用。
- 后续 idle 且 `sendMessage` 返回后 Promise resolve，消息只发送 1 次。
- `ctx.isIdle()` 抛错、超过最大轮询次数或 `sendMessage` 抛错时，Promise 以带稳定 reason 的 `StoryDeliveryError` reject，不静默返回。

- [ ] **步骤 2：编写 delivery completion 与 snapshot 红灯测试**

在 `commitTurn` harness 中持久化一个 System state。`await commitTurn(...)` 返回时只完成 Writer 和投递调度：

```ts
const result = await commitTurn(input);
assert.equal(result.rendered, true);
assert.equal(countSnapshots(db, saveId), 0);

releaseIdleDelivery();
const committed = await result.completion;
assert.equal(committed.snapshotTurnNo, 1);
```

Completion resolve 后读取最新 envelope，断言包含 core + System payload。`sendMessage` 必须已在 snapshot 插入前返回。

- [ ] **步骤 3：编写失败边界测试**

- Writer 失败：不 capture，已有 State commit 保留。
- Session stale、idle timeout 或 `sendMessage` 失败：completion reject，不 capture、不发布 `turn-rendered`。
- Snapshot capture 失败：正文已经由 Pi 接受，但 completion reject 且不发布 `turn-rendered`；不回滚先前 State commit。
- `needsRender=false`：不 capture。

- [ ] **步骤 4：运行测试确认红灯**

```bash
npm test -- test/runtime/idle-delivery.test.ts test/runtime/turn-commit.test.ts test/runtime/extension-runtime.test.ts test/e2e/demo-flow.test.ts
```

- [ ] **步骤 5：实现可观察 delivery Promise**

`deliverWhenIdle()` 的 timer callback 必须捕获同步异常并 settle 同一个 Promise。成功条件严格限定为：

```ts
sendMessage(message, { triggerTurn: false });
resolve();
```

登记 timer 不得提前 resolve。失败 reason 至少区分 `SESSION_STALE`、`IDLE_TIMEOUT` 与 `SEND_FAILED`。

- [ ] **步骤 6：让 `commitTurn()` 返回后台 completion**

公开结果改为：

```ts
export type StoryCommitCompletion = Readonly<{ snapshotTurnNo: number }>;

export type CommitTurnResult =
  | Readonly<{
      rendered: true;
      prose: string;
      completion: Promise<StoryCommitCompletion>;
    }>
  | Readonly<{
      rendered: false;
      directReply: string;
      completion: Promise<void>;
    }>;
```

`CommitTurnInput` 删除只表示“写入内存数组”的 `writeCustomMessage`，改为：

```ts
deliverCustomMessage(message: RuntimeMessage): Promise<void>;
storySnapshots: StorySnapshotCoordinator;
```

`turn-hook.ts` 用 `message => deliverWhenIdle({ ctx, sendMessage, message: runtimeMessageToOutbound(message) })` 注入真实投递函数。`commitTurn()` 调用 Writer 后立即启动该函数，并把“投递确认 -> `storySnapshots.captureSuccessfulStory()`”链成 completion。它返回 completion 但不等待它。

`agent_end` handler 必须先为 completion 注册 `.then/.catch` 再返回；不得在 handler 内 `await completion`，否则 Pi 可能要等 handler 返回后才进入 idle，形成死锁。Rendered completion 成功后才调用 `emitTurnRendered`；失败只记录 commit-stage error，不发布成功事件。

- [ ] **步骤 7：迁移测试 helper**

为无 System module 测试提供 empty registry/runtime/coordinator helper 和 controlled idle delivery，避免每个测试手工拼装。E2E 必须先释放 idle delivery、等待 completion，再断言 snapshot 与 `turn-rendered`。

- [ ] **步骤 8：验证并提交**

```bash
npm test -- test/runtime/idle-delivery.test.ts test/runtime/turn-commit.test.ts test/runtime/extension-runtime.test.ts test/e2e/demo-flow.test.ts
npm run typecheck
git add src/runtime/idle-delivery.ts src/runtime/turn-commit.ts src/runtime/turn-hook.ts extensions/two-pass-render/index.ts test/runtime/idle-delivery.test.ts test/runtime/turn-commit.test.ts test/runtime/extension-runtime.test.ts test/e2e/demo-flow.test.ts test/helpers/extensions.ts
git commit -m "feat(snapshot): capture systems after story delivery"
```

## 任务 7：重写 `/roll` Active Chain 语义

**文件：**

- 修改：`src/commands/context.ts`
- 修改：`src/commands/registry.ts`
- 修改：`src/commands/roll.ts`
- 修改：`src/world/materialize-dynamic-roles.ts`
- 修改测试：`test/commands/roll.test.ts`
- 修改测试：`test/commands/extension-commands.test.ts`

- [ ] **步骤 1：更新 rerun failure 旧测试**

当前测试断言 rerun 失败后恢复 roll 前的 latest state；这与批准规格冲突。新断言：restore 已成功后不复活 superseded turn。若 rerun 在失败前完成 State commit，该 commit 保留；没有 commit 时保持前驱 snapshot state。

- [ ] **步骤 2：编写完整 `/roll` 红灯场景**

覆盖：

- 缺少 rerun capability/最新用户输入时，restore 尚未开始。
- 兼容性预检失败时所有 participant 和 snapshot chain 不变。
- 成功 restore 后先 materialize roles，再调用 rerun。
- 成功 restore 把 revision 与 branchEpoch 各推进 1；restore 前的 expected revision 随即冲突。
- Superseded branch 的同 requestId receipt 不命中新分支；rerun 可以执行并生成新 commitId。
- Rerun 成功 capture replacement 时复用逻辑 turn number。
- Replacement 后连续 `/roll` 仍从同一 predecessor 重跑，不走到更早 turn。
- Superseded System projection 不再可见。

- [ ] **步骤 3：运行测试确认红灯**

```bash
npm test -- test/commands/roll.test.ts test/commands/extension-commands.test.ts
```

- [ ] **步骤 4：让 command 使用 coordinator**

`CommandContext` 增加 `storySnapshots`。`roll.execute()` 顺序：前置能力检查 -> coordinator restore（含 revision/branchEpoch 推进）-> StateStore hydrate/System activate -> invalidate/materialize roles -> `rerunTurn(latestUserMessage)`。

不要在 `rerunTurn` error catch 中恢复 superseded snapshot；返回清晰信息说明 restore 已完成但 rerun 失败。

- [ ] **步骤 5：验证并提交**

```bash
npm test -- test/commands/roll.test.ts test/commands/extension-commands.test.ts
npm run typecheck
git add src/commands/context.ts src/commands/registry.ts src/commands/roll.ts src/world/materialize-dynamic-roles.ts test/commands/roll.test.ts test/commands/extension-commands.test.ts
git commit -m "feat(snapshot): reroll active story branch"
```

## 任务 8：迁移剩余 Snapshot 调用者并全量验证

**文件：**

- 修改测试：`test/hooks/engine.test.ts`
- 修改测试：`test/subagents/role-runtime.test.ts`
- 修改测试：`test/world/hooks-border-station.test.ts`
- 修改测试：`test/state/sqlite.test.ts`
- 修改：`src/state/snapshots.ts`

- [ ] **步骤 1：统一测试 snapshot factory**

把直接写 core-only snapshot 的测试迁移到 empty-registry coordinator 或 `recordEmptySystemStorySnapshot()` test helper。生产代码不得继续创建 legacy row。

- [ ] **步骤 2：保留 turn number 兼容测试**

Hook cadence 和 role trajectory 仍通过 `latestStorySnapshotTurnNo()` 取得 active story turn；superseded row 不计数，replacement 使用同一逻辑 turn number。

- [ ] **步骤 3：删除/封闭 core-only 写入口**

`src/state/snapshots.ts` 不再导出能只传 `RpState` 的 production capture 函数。只保留 active turn 查询与 coordinator 所需低层 row 函数。

- [ ] **步骤 4：运行完整验证**

```bash
npm test -- test/state/*.test.ts test/commands/roll.test.ts test/runtime/idle-delivery.test.ts test/runtime/turn-commit.test.ts test/runtime/extension-runtime.test.ts test/hooks/engine.test.ts test/subagents/role-runtime.test.ts test/world/hooks-border-station.test.ts test/e2e/demo-flow.test.ts
npm run typecheck
npm test
git diff --check
```

- [ ] **步骤 5：提交**

```bash
git add src/state/snapshots.ts test/hooks/engine.test.ts test/subagents/role-runtime.test.ts test/world/hooks-border-station.test.ts test/state/sqlite.test.ts
git commit -m "test(snapshot): enforce full story envelopes"
```

## 完成条件

- 每个新 story snapshot 包含 core、全部 System opaque payload、dynamic roles、trajectory 和 capability participant map。
- Existing save 的最新 core-only row 会升级为当前完整状态基线；再成功交付 1 个故事回合后 `/roll` 可用。
- Missing module、未来版本、migration/parser 或第二 participant 失败时 restore 零写入。
- `/roll` 原子 supersede 最新 story turn，同时推进 revision/branchEpoch，并在普通 rerun 中遵循 Writer 失败不回滚 State commit 的规则。
- 旧分支 receipt 不命中新分支；restore 前的 expected revision 必须冲突。
- Story snapshot 只在 Pi 投递确认后创建；session stale、idle timeout 或 send failure 不 snapshot、不发布 `turn-rendered`。
- 连续 `/roll` 重掷同一最新故事回合，不恢复 superseded 分支。
- Hook cadence/fire-state 与 OpenViking 不进入 envelope，也不因 `/roll` 回退。
- 生产代码不再写 core-only snapshot。
