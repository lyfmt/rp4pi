# System Transaction Runtime 与 Command Dispatch 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:test-driven-development 和 superpowers:executing-plans。若调度子代理，必须显式设置项目允许的 `model` 与 `reasoning_effort=medium`；工具不能同时设置时禁止调度。

**目标：** 在已激活的 System state 上实现 `commit()` 与 `project()`，支持有序多系统 batch、零部分提交、revision conflict，以及按 branch epoch 隔离的 requestId idempotency。

**架构：** Adapter 在 JSON-compatible operation batch 上注入可信 `saveId/requestId/caller`；projection request 同样携带 adapter 注入的 `saveId/audience`。Runtime 在真实 SQLite `BEGIN IMMEDIATE` 中读取当前 revision 与 branch epoch、构造 module-owned candidate state、顺序执行 handler、验证每个 next state，最后一次性写入 payload、revision 与当前分支 receipt；任一错误整体回滚。

**技术栈：** TypeScript、Node 24、`node:sqlite`、Node test runner。

---

## 前置条件

- 已完成 `2026-07-10-system-registry-persistence-migration.md`。
- `SystemRegistry`、`activateSystemSave()` 与 `system_states` 已可用。
- 本计划不注册 GM 工具，不修改 `submit_direction_packet` 或 Writer 链路。

## 文件结构

- 创建：`src/systems/canonical-json.ts`
  - 对 JSON value 做稳定 key 排序并生成 request fingerprint。
- 创建：`src/systems/commit-repository.ts`
  - 管理 save revision、branch epoch 和成功 idempotency receipt。
- 创建：`src/systems/runtime.ts`
  - 实现 `activateSave()` 生命周期、`commit()`、`project()` 与 transaction read view。
- 修改：`src/systems/types.ts`
  - 固定 operation、request、receipt、projection 与可信 caller 的公开类型。
- 修改：`src/state/sqlite.ts`
  - 增加 `system_save_revisions`、`system_commit_receipts`。
- 修改：`src/runtime/bootstrap.ts`
  - 从 db + registry 构造共享 `systemRuntime`，但不绑定 Pi。
- 创建测试：`test/systems/canonical-json.test.ts`
- 创建测试：`test/systems/commit-repository.test.ts`
- 创建测试：`test/systems/runtime.test.ts`
- 修改测试：`test/state/sqlite.test.ts`
- 修改测试：`test/runtime/bootstrap-systems.test.ts`

## 任务 1：添加 Revision、Branch Epoch 与 Idempotency 存储

**文件：**

- 修改：`src/state/sqlite.ts`
- 创建：`src/systems/commit-repository.ts`
- 修改测试：`test/state/sqlite.test.ts`
- 创建测试：`test/systems/commit-repository.test.ts`

- [ ] **步骤 1：更新 schema 红灯测试**

把以下表加入 `initializeSchema creates all state tables`：

```text
system_save_revisions
system_commit_receipts
```

并验证外键按 save cascade。

- [ ] **步骤 2：运行测试确认红灯**

```bash
npm test -- test/state/sqlite.test.ts
```

- [ ] **步骤 3：创建表**

```sql
CREATE TABLE IF NOT EXISTS system_save_revisions (
  save_id TEXT PRIMARY KEY REFERENCES saves(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  branch_epoch INTEGER NOT NULL CHECK(branch_epoch >= 0)
);

CREATE TABLE IF NOT EXISTS system_commit_receipts (
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  branch_epoch INTEGER NOT NULL CHECK(branch_epoch >= 0),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (save_id, branch_epoch, request_id)
);
```

- [ ] **步骤 4：编写 repository 红灯测试**

覆盖：

- `ensureSaveCommitMetadata()` 初始化 `{ revision: 0, branchEpoch: 0 }` 且不重置已有值。
- `readSaveCommitMetadata()` / `writeSaveRevision()`。
- `advanceSaveBranchMetadata()` 在调用者事务内把 revision 与 branch epoch 各加 1，并返回新值；本计划只提供 helper，第四份计划的 restore 才调用它。
- `readCommitReceipt()` 按 `(saveId, branchEpoch, requestId)` 取回 hash + receipt。
- 同一 `(saveId, branchEpoch, requestId)` 不可覆盖不同 hash；不同 branch epoch 可复用相同 requestId。
- 不存在 save 时 revision/receipt 写入失败。

- [ ] **步骤 5：实现最少具体 SQLite 函数**

不创建抽象 repository interface；所有写函数假设调用者控制 transaction。

- [ ] **步骤 6：验证并提交**

```bash
npm test -- test/state/sqlite.test.ts test/systems/commit-repository.test.ts
npm run typecheck
git add src/state/sqlite.ts src/systems/commit-repository.ts test/state/sqlite.test.ts test/systems/commit-repository.test.ts
git commit -m "feat(system): persist revisions and receipts"
```

## 任务 2：固定 Canonical Batch Fingerprint

**文件：**

- 创建：`src/systems/canonical-json.ts`
- 测试：`test/systems/canonical-json.test.ts`

- [ ] **步骤 1：编写稳定 fingerprint 红灯测试**

```ts
test("fingerprint ignores object key order but preserves operation order", () => {
  assert.equal(
    fingerprintBatch([{ system: "x", command: "set", input: { a: 1, b: 2 } }]),
    fingerprintBatch([{ system: "x", command: "set", input: { b: 2, a: 1 } }])
  );
  assert.notEqual(fingerprintBatch([first, second]), fingerprintBatch([second, first]));
});
```

拒绝 `undefined`、function、symbol、非有限 number 和循环对象。

- [ ] **步骤 2：运行测试确认红灯**

```bash
npm test -- test/systems/canonical-json.test.ts
```

- [ ] **步骤 3：实现稳定 JSON 和 SHA-256 hash**

只规范化 object key 顺序；array/operation 顺序保持。不要把 module parser 的 coercion 纳入 hash，requestId 比较的是调用者提交的 canonical JSON request。

- [ ] **步骤 4：验证并提交**

```bash
npm test -- test/systems/canonical-json.test.ts
npm run typecheck
git add src/systems/canonical-json.ts test/systems/canonical-json.test.ts
git commit -m "feat(system): fingerprint commit requests"
```

## 任务 3：实现单 Command Commit 与 Projection

**文件：**

- 修改：`src/systems/types.ts`
- 创建：`src/systems/runtime.ts`
- 测试：`test/systems/runtime.test.ts`

- [ ] **步骤 1：建立真实 SQLite harness**

Harness 必须：创建临时 SQLite、初始化 schema/save、创建 registry、调用 `runtime.activateSave(saveId)`；不要 mock repository。

- [ ] **步骤 2：编写单 command 红灯测试**

```ts
const receipt = await runtime.commit({
  saveId,
  requestId: "call-1",
  caller: { kind: "gm", sessionId: "session-test" },
  operations: [
    { system: "progression", command: "gain_xp", input: { amount: 25 } }
  ]
});

assert.equal(receipt.revision, 1);
assert.deepEqual(receipt.operations[0]?.result, { level: 2, xp: 75 });
assert.deepEqual((await runtime.project({
  saveId,
  audience: { kind: "gm" },
  systems: ["progression"]
}))[0]?.value, { level: 2, xp: 75, perks: [] });
```

- [ ] **步骤 3：编写失败测试**

覆盖：空 operations、未知 system、未知 command、input parser 拒绝、handler 抛错、next state parser 拒绝、result/projection 不可序列化、未 activation 的 save。

每类失败都断言稳定 `SystemRuntimeError.code` 和结构化 context。Operation 失败 context 至少包含 `index/system/command`；测试不得依赖解析 message 字符串。未知 handler 异常统一包装为 `COMMAND_FAILED`，registration/activation programmer error 不在 `commit()` 中伪装成领域拒绝。

所有失败必须重新读取 `system_states` 和 revision，断言零写入。

- [ ] **步骤 4：运行测试确认红灯**

```bash
npm test -- test/systems/runtime.test.ts
```

- [ ] **步骤 5：实现公开 types 与 runtime factory**

```ts
export type SystemOperation = Readonly<{
  system: string;
  command: string;
  input: unknown;
}>;

export type StateCommitRequest = Readonly<{
  requestId: string;
  expectedRevision?: number;
  operations: readonly [SystemOperation, ...SystemOperation[]];
}>;

export type RuntimeCaller =
  | Readonly<{ kind: "gm"; sessionId: string }>
  | Readonly<{ kind: "system"; name: string }>
  | Readonly<{ kind: "worker"; name: string }>;

export type StateCommitReceipt = Readonly<{
  commitId: string;
  revision: number;
  branchEpoch: number;
  operations: readonly Readonly<{ system: string; command: string; result: unknown }>[];
}>;

export type ProjectionRequest = Readonly<{
  audience: ProjectionAudience;
  systems?: readonly string[];
}>;

export type SystemProjection = Readonly<{
  system: string;
  revision: number;
  value: unknown;
}>;

export type RuntimeStateCommitRequest = StateCommitRequest & {
  saveId: string;
  caller: RuntimeCaller;
};

export type RuntimeProjectionRequest = ProjectionRequest & { saveId: string };

export type ActivatedSystemSave = Readonly<{
  saveId: string;
  revision: number;
  branchEpoch: number;
}>;

export type SystemRuntime = {
  commit(request: RuntimeStateCommitRequest): Promise<StateCommitReceipt>;
  project(request: RuntimeProjectionRequest): Promise<SystemProjection[]>;
};

export type SystemRuntimeLifecycle = SystemRuntime & {
  activateSave(saveId: string): ActivatedSystemSave;
};
```

Infrastructure 保存 `SystemRuntimeLifecycle`；adapter 在新建/加载 save 时使用 `activateSave()`，但 GM、Writer、System module 和普通调用测试只依赖 `SystemRuntime`。运行时主要行为入口仍只有 `commit()` 和 `project()`。System module handler 不接收 `RuntimeCaller`。

- [ ] **步骤 6：实现单 command transaction**

顺序：outer envelope/fingerprint -> `BEGIN IMMEDIATE` -> ready/revision/branch epoch -> parse input -> execute sync handler -> parse next state -> serialize result -> 生成一次 `crypto.randomUUID()` commitId -> write state/revision/current-branch receipt -> `COMMIT`。

首次成功生成的 commitId 随 receipt 持久化；同分支幂等重放返回原 receipt，不生成新 commitId。测试必须断言 commitId 非空且重放保持相同。

Command 返回 Promise 时以 `COMMAND_FAILED` 拒绝；SQLite transaction 内不得跨 `await`。`commit()` 可以是 async facade，但内部 transaction block 同步完成。

- [ ] **步骤 7：验证并提交**

```bash
npm test -- test/systems/runtime.test.ts
npm run typecheck
git add src/systems/types.ts src/systems/runtime.ts test/systems/runtime.test.ts
git commit -m "feat(system): execute commands through runtime"
```

## 任务 4：实现多 System 原子 Batch 与 Read View

**文件：**

- 修改：`src/systems/runtime.ts`
- 修改测试：`test/systems/runtime.test.ts`

- [ ] **步骤 1：编写第二 operation 失败红灯测试**

Batch 先让 `generator.create_blueprint` 产生候选 state，再让 `quest.record_blueprint` 抛错。断言：

```ts
assert.deepEqual(readSystemState(db, saveId, "generator"), beforeGenerator);
assert.deepEqual(readSystemState(db, saveId, "quest"), beforeQuest);
assert.deepEqual(readSaveCommitMetadata(db, saveId), { revision: 0, branchEpoch: 0 });
assert.equal(readCommitReceipt(db, saveId, 0, "call-batch"), undefined);
```

同时断言错误 context 为 `{ index: 1, system: "quest", command: "record_blueprint", ... }`，不得丢失第二个 operation 的定位信息。

- [ ] **步骤 2：编写顺序与跨系统 read view 测试**

`quest.dependsOn = ["generator"]`。第二 handler 调用 `context.read("generator")`，应看到第一个 operation 已验证的候选 projection。覆盖：

- 未声明依赖读取 -> `DEPENDENCY_UNAVAILABLE`。
- 读取原始 payload 的入口不存在。
- 同一个 system 的多个 operation 按顺序看到前一个 next state。

- [ ] **步骤 3：运行测试确认红灯**

```bash
npm test -- test/systems/runtime.test.ts
```

- [ ] **步骤 4：实现 candidate state map**

Transaction 开始时解析 registry 中当前 save 的全部 ready state。每次 operation 更新内存 candidate；只有 batch 全部成功后才写 changed namespace。Read view 调用目标 module 的 `project({ audience: { kind: "system", name: caller } })`。

- [ ] **步骤 5：验证并提交**

```bash
npm test -- test/systems/runtime.test.ts
npm run typecheck
git add src/systems/runtime.ts test/systems/runtime.test.ts
git commit -m "feat(system): commit atomic operation batches"
```

## 任务 5：实现 Conflict、Idempotency 与明确重试语义

**文件：**

- 修改：`src/systems/commit-repository.ts`
- 修改：`src/systems/runtime.ts`
- 修改测试：`test/systems/runtime.test.ts`

- [ ] **步骤 1：编写 expectedRevision 红灯测试**

成功 revision 已为 1 后，用 `expectedRevision: 0` 提交，预期 `STATE_COMMIT_CONFLICT` 且 handler 调用计数为 0。

- [ ] **步骤 2：编写 requestId 重放红灯测试**

覆盖：

- 相同 requestId + 相同 canonical batch 返回原 receipt，handler 只执行 1 次。
- 相同 requestId + 不同 input 返回 `IDEMPOTENCY_CONFLICT`。
- Replay 不推进 revision、不重复 result side effect。
- 手工调用 `advanceSaveBranchMetadata()` 后，相同 requestId + 相同 batch 属于新分支请求，handler 再执行 1 次并产生新 commitId。
- 分支推进前读取的 `expectedRevision` 在推进后返回 `STATE_COMMIT_CONFLICT`。
- 未提供 expectedRevision 时，两个顺序 commit 基于最新 state，revision 依次为 1、2。

- [ ] **步骤 3：实现检查顺序**

在 handler 前按以下顺序：

```text
BEGIN IMMEDIATE
-> read revision + branch epoch
-> existing receipt in current branch epoch?
   same hash -> COMMIT/return stored receipt
   different hash -> ROLLBACK/IDEMPOTENCY_CONFLICT
-> expected revision check
-> handlers
```

只允许在 `BEGIN IMMEDIATE` 尚未成功、任何 handler 未执行前重试 lock acquisition；测试不依赖 sleep。

- [ ] **步骤 4：验证并提交**

```bash
npm test -- test/systems/runtime.test.ts test/systems/commit-repository.test.ts
npm run typecheck
git add src/systems/commit-repository.ts src/systems/runtime.ts test/systems/runtime.test.ts
git commit -m "feat(system): enforce commit idempotency"
```

## 任务 6：接入共享 Infrastructure

**文件：**

- 修改：`src/runtime/bootstrap.ts`
- 修改测试：`test/runtime/bootstrap-systems.test.ts`

- [ ] **步骤 1：编写 bootstrap 红灯测试**

```ts
const infra = createRuntimeInfrastructure(projectRoot);
assert.equal(typeof infra.systemRuntime.commit, "function");
assert.equal(typeof infra.systemRuntime.project, "function");
```

同一个 projectRoot 的 3 个 extension 必须得到同一 runtime 实例。

- [ ] **步骤 2：运行测试确认红灯**

```bash
npm test -- test/runtime/bootstrap-systems.test.ts
```

- [ ] **步骤 3：构造并缓存 runtime**

`RuntimeInfrastructure` 增加 `systemRuntime`；从同一个 db + `systemRegistry` 构造。不要在 bootstrap 无 active save 时调用 `activateSave()`。

- [ ] **步骤 4：运行完整验证**

```bash
npm test -- test/systems/*.test.ts test/runtime/bootstrap-systems.test.ts test/state/sqlite.test.ts
npm run typecheck
npm test
git diff --check
```

- [ ] **步骤 5：提交**

```bash
git add src/runtime/bootstrap.ts test/runtime/bootstrap-systems.test.ts
git commit -m "feat(system): expose transaction runtime"
```

## 完成条件

- `commit()` 是单/多 System state 的唯一写 interface；`project()` 是唯一读取 interface。
- 第二 operation、parser、handler 或 serialization 失败时零写入。
- Revision、changed payload 和成功 receipt 同事务提交。
- Receipt 主键包含 branch epoch；同分支相同 requestId 重放不重复执行，不同 batch 明确冲突，新分支不复用旧 receipt。
- 首次成功 receipt 有稳定 commitId；重放返回同一 commitId。
- Cross-system read 只能经过已声明依赖的 candidate projection。
- 本计划没有 Pi `commit_turn`、Writer 交接、story snapshot 扩展或 probe 世界实现。
