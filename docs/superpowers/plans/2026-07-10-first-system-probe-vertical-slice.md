# 首个 System Probe 垂直切片实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:test-driven-development 和 superpowers:executing-plans。若调度子代理，必须显式设置项目允许的 `model` 与 `reasoning_effort=medium`；工具不能同时设置时禁止调度。

**目标：** 在 `border-station` 世界落地 `relay-blueprints` 生成系统，通过真实 `commit_turn`、projection、Writer story snapshot 和 `/roll` 验证完整 System module interface。

**架构：** `relay-blueprints` 是 world-local `defineSystem()` module，独占 `{ blueprints: [...] }` schema、输入/state validation、`create` command 和 GM/Writer projection。核心只加载 definition、路由 operation、保存 opaque payload；该 slice 不增加核心 entity kind，也不使用 RNG/jobs/audit/visibility。

**P1 边界：** 本计划以生成系统真实垂直切片收口 P1；可升级自定义系统由前 4 份计划的 activation、command、snapshot migration 与 restore 集成测试覆盖。RNG 保留到 P3，抽卡/RNG 完整探针不属于本计划完成条件。

**技术栈：** TypeScript、Node 24、Pi tool contract、`node:sqlite`、Node test runner、现有 border-station world pack。

---

## 前置条件

- 前 4 份 P1 计划已按顺序完成。
- `commit_turn`、System projection、完整 story snapshot 和 `/roll` 已可用。
- 本计划是首个真实 probe，不承担第二个 capability 或通用 generator framework。

## 文件结构

- 创建：`worlds/border-station/systems/relay-blueprints.ts`
  - `relay-blueprints` definition、state/input parser、create command、projection。
- 修改：`worlds/border-station/world.yaml`
  - 注册 module path。
- 修改：`worlds/border-station/prompts/gm-tools.md`
  - 说明何时使用 blueprint operation。
- 修改：`worlds/_template/world.yaml`
  - 保留注释示例，不默认启用具体系统。
- 修改：`skills/development-guide/references/world-pack.md`
  - 增加完整 `defineSystem()` 示例。
- 修改：`README.md`
  - 标明 demo 包含首个 System module slice。
- 修改：`docs/design/project-control-plane.md`
  - 按实际代码更新当前实现/缺口/P1 状态。
- 修改：`docs/plans/00-roadmap.md`
  - 只把已实现的 System P1 slice 标为完成。
- 创建测试：`test/world/relay-blueprints.test.ts`
- 创建测试：`test/e2e/system-probe-flow.test.ts`
- 修改测试：`test/world/loader.test.ts`
- 修改测试：`test/runtime/extension-runtime.test.ts`
- 修改测试：`test/guards/project-control-plane.test.ts`

## 任务 1：用 TDD 定义 Relay Blueprint Module

**文件：**

- 创建：`worlds/border-station/systems/relay-blueprints.ts`
- 创建测试：`test/world/relay-blueprints.test.ts`

- [ ] **步骤 1：编写 initial state 与 parser 红灯测试**

```ts
const state = relayBlueprints.initialize();
assert.deepEqual(relayBlueprints.parse(state), { blueprints: [] });
```

State schema：

```ts
type RelayBlueprint = {
  id: string;
  parts: string[];
  stability: number;
};

type RelayBlueprintState = {
  blueprints: RelayBlueprint[];
};
```

Parser 拒绝重复 id、空 parts、非 slug id、非有限 stability 或 stability 不在 `[0, 1]`。

- [ ] **步骤 2：运行测试确认红灯**

```bash
npm test -- test/world/relay-blueprints.test.ts
```

预期：FAIL，module 不存在。

- [ ] **步骤 3：实现最少 definition**

```ts
export const relayBlueprints = defineSystem({
  name: "relay-blueprints",
  version: 1,
  initialize: () => ({ blueprints: [] }),
  parse: parseRelayBlueprintState,
  commands: {
    create: {
      parseInput: parseCreateBlueprintInput,
      execute(_context, state, input) {
        const blueprint = { id: input.id, parts: input.parts, stability: input.stability };
        return {
          nextState: { blueprints: [...state.blueprints, blueprint] },
          result: { id: blueprint.id, accepted: true }
        };
      }
    }
  },
  project(_context, state) {
    return {
      count: state.blueprints.length,
      blueprints: state.blueprints.map(({ id, parts, stability }) => ({
        id,
        partCount: parts.length,
        stability
      }))
    };
  }
});
```

- [ ] **步骤 4：编写 command 成功/失败测试**

覆盖：

- 合法 create 返回新 state + serializable result。
- 重复 id 由 state parser/handler 拒绝。
- input 缺字段、空 parts、越界 stability 由 input parser 拒绝。
- Projection 不返回可写 state reference；修改 projection 不影响原 state。

- [ ] **步骤 5：运行测试并提交**

```bash
npm test -- test/world/relay-blueprints.test.ts
npm run typecheck
git add worlds/border-station/systems/relay-blueprints.ts test/world/relay-blueprints.test.ts
git commit -m "feat(world): define relay blueprint system"
```

## 任务 2：从 Border Station World 注册 Module

**文件：**

- 修改：`worlds/border-station/world.yaml`
- 修改测试：`test/world/loader.test.ts`

- [ ] **步骤 1：编写 shipped world 红灯测试**

```ts
const world = loadWorldFromDir(join(repoRoot, "worlds", "border-station"));
assert.deepEqual(world.systemModulePaths, [
  join(world.root, "systems", "relay-blueprints.ts")
]);

const definitions = loadSystemDefinitions(world.systemModulePaths);
assert.deepEqual(definitions.map((entry) => entry.name), ["relay-blueprints"]);
```

- [ ] **步骤 2：运行测试确认红灯**

```bash
npm test -- test/world/loader.test.ts
```

- [ ] **步骤 3：在 manifest 声明 module**

```yaml
systems:
  - ./systems/relay-blueprints.ts
```

不要把它放进 `tools.extra`；System module 不是 Pi tool。

- [ ] **步骤 4：验证并提交**

```bash
npm test -- test/world/loader.test.ts test/runtime/bootstrap-systems.test.ts
npm run typecheck
git add worlds/border-station/world.yaml test/world/loader.test.ts
git commit -m "feat(world): register relay blueprint system"
```

## 任务 3：验证真实 Commit、Projection 与 Atomic Failure

**文件：**

- 创建测试：`test/e2e/system-probe-flow.test.ts`
- 修改测试：`test/runtime/extension-runtime.test.ts`

- [ ] **步骤 1：建立真实 extension harness**

通过 `activateAllExtensions()`、临时 `RP_SQLITE_PATH` 和 `RP_WORLD=border-station` 收集实际 tools/commands/hooks。不得直接调用 module handler 代替 Pi binding。

- [ ] **步骤 2：编写成功链路红灯测试**

```text
initialize_new_game
-> commit_turn(relay-blueprints.create)
-> get_status
```

断言：

- `commit_turn` 不 terminate。
- Receipt revision 为 1，result 只含 `{ id, accepted }`。
- Receipt branchEpoch 为 0，commitId 非空。
- `get_status` 包含 `relay-blueprints` projection 的 id/count。
- Tool result/details 不包含 `payload_json` 或 `parts` 原始数组。
- SQLite `system_states` 保存 version 1 opaque payload。

- [ ] **步骤 3：编写同 System 双 operation 原子失败测试**

一个 batch 依次 create `relay-alpha`、再次 create 相同 id。第二 operation 失败后断言：

- `relay-alpha` 没有提交。
- revision 不变。
- requestId 没有成功 receipt。
- `get_status` projection 仍为 0。

- [ ] **步骤 4：编写跨 System 原子性测试 fixture**

在测试内创建一个 `blueprint-quest` definition（不加入 shipped world），它依赖 `relay-blueprints` 并读取 candidate projection。验证：

- `create` + `record_blueprint` 一起成功。
- 第二 handler 失败时，两个 namespace 都不提交。
- Quest 不能读取 relay 的原始 payload，只能读 projection。

- [ ] **步骤 5：运行测试确认红灯/绿灯**

```bash
npm test -- test/e2e/system-probe-flow.test.ts test/runtime/extension-runtime.test.ts
```

如实现基础正确，测试应在补齐 fixture/harness 后直接绿；若暴露 adapter bug，先为该 bug 保留失败断言，再修改对应最小实现。

- [ ] **步骤 6：提交**

```bash
git add test/e2e/system-probe-flow.test.ts test/runtime/extension-runtime.test.ts
git commit -m "test(system): verify blueprint transaction flow"
```

## 任务 4：验证 Story Snapshot、Writer Failure 与 `/roll`

**文件：**

- 修改测试：`test/e2e/system-probe-flow.test.ts`

- [ ] **步骤 1：编写 snapshot/roll 端到端场景**

```text
initialize_new_game
-> submit_direction_packet + Writer success + delivery completion -> snapshot 1（无 blueprint）
-> commit_turn create relay-alpha
-> submit_direction_packet + Writer success + delivery completion -> snapshot 2（含 blueprint）
-> /roll -> restore snapshot 1 -> rerun callback
```

断言 `/roll` 后：

- Core state 恢复 snapshot 1。
- `relay-blueprints` projection count 回到 0。
- Revision 从 1 推进到 2，branchEpoch 从 0 推进到 1。
- Snapshot 2 从 active chain 移除。
- Rerun 收到原玩家输入。
- Hook cadence row 和 OpenViking 调用不参与 restore 断言。

随后在 branch 1 使用与已回退 create 相同的 requestId/batch 再提交一次，断言 handler 真实执行、产生新 commitId，而不是返回 branch 0 receipt。

- [ ] **步骤 2：编写 Writer failure 场景**

```text
commit_turn create relay-beta 成功
-> submit_direction_packet
-> fake Writer 抛错
```

断言 relay-beta state/revision 保留，不创建新 story snapshot，不发布 `turn-rendered`。另让 idle delivery timeout 和 `sendMessage` 抛错，断言同样不创建 snapshot；只有 delivery completion resolve 后才允许查询新 row。

- [ ] **步骤 3：编写 snapshot missing module 场景**

捕获含 relay module 的 snapshot 后，用不含该 definition 的 registry 尝试 restore，预期 `SNAPSHOT_INCOMPATIBLE`，core/System/snapshot chain 不变。

- [ ] **步骤 4：运行测试并提交**

```bash
npm test -- test/e2e/system-probe-flow.test.ts test/commands/roll.test.ts test/runtime/turn-commit.test.ts
npm run typecheck
git add test/e2e/system-probe-flow.test.ts
git commit -m "test(system): verify blueprint snapshot rollback"
```

## 任务 5：更新 GM 指引与 World Pack 示例

**文件：**

- 修改：`worlds/border-station/prompts/gm-tools.md`
- 修改：`worlds/_template/world.yaml`
- 修改：`skills/development-guide/references/world-pack.md`
- 修改：`README.md`

- [ ] **步骤 1：更新 border-station GM 指引**

加入一个可直接照用的 operation：

```json
{
  "operations": [
    {
      "system": "relay-blueprints",
      "command": "create",
      "input": {
        "id": "relay-alpha",
        "parts": ["core", "antenna"],
        "stability": 0.82
      }
    }
  ]
}
```

明确 create 只在剧情确立新设计时调用；状态推进后仍需单独 `submit_direction_packet`。

- [ ] **步骤 2：补齐 template 和指南**

指南展示 module 目录：

```text
worlds/<name>/
├── world.yaml
└── systems/
    └── my-system.ts
```

说明 module 自有 schema/version/commands/projection，禁止 import `src/state/sqlite.ts` 或 Pi types。

- [ ] **步骤 3：更新 README demo 描述**

只写已实现事实：border-station 包含首个 `relay-blueprints` System module；不宣称 RNG/jobs/audit/visibility 已实现。

- [ ] **步骤 4：验证文档与提交**

```bash
rg -n "relay-blueprints|systems:" worlds/border-station worlds/_template skills/development-guide/references/world-pack.md README.md
git diff --check
git add worlds/border-station/prompts/gm-tools.md worlds/_template/world.yaml skills/development-guide/references/world-pack.md README.md
git commit -m "docs(system): document first world module"
```

## 任务 6：同步控制面并完成全量验收

**文件：**

- 修改：`docs/design/project-control-plane.md`
- 修改：`docs/plans/00-roadmap.md`
- 修改测试：`test/guards/project-control-plane.test.ts`

- [ ] **步骤 1：先更新 guard 目标**

Guard 必须要求控制面准确记录：

- Registry、namespaced state、transaction runtime、GM `commit_turn`、full snapshot/roll 已实现。
- 首个 generator probe 已落地。
- 可升级自定义系统的 activation、command、snapshot migration 与 restore 验收已由前 4 份计划覆盖。
- RNG/jobs/audit/visibility adapter 仍是缺口。
- NPC runtime 与 Writer 三回合规划仍未实现。

- [ ] **步骤 2：运行 guard 确认红灯**

```bash
npm test -- test/guards/project-control-plane.test.ts
```

- [ ] **步骤 3：更新控制面和路线图**

从“当前缺口”删除已经真实落地的 System runtime 条目；保留尚未实现项。P1 状态改为“System runtime、生成探针与升级验收已完成”，不要把 P2/P3 写成完成。控制面必须明确抽卡/RNG 完整探针属于 P3。

- [ ] **步骤 4：运行完整验证**

```bash
npm test -- test/world/relay-blueprints.test.ts test/e2e/system-probe-flow.test.ts test/guards/project-control-plane.test.ts test/guards/turn-boundary.test.ts
npm run typecheck
npm test
git diff --check
```

预期：全部 PASS；全量测试无新增 warning（Node SQLite experimental warning 除外）。

- [ ] **步骤 5：提交**

```bash
git add docs/design/project-control-plane.md docs/plans/00-roadmap.md test/guards/project-control-plane.test.ts
git commit -m "docs(system): mark first probe implemented"
```

## 完成条件

- Border-station 启动时注册且初始化 `relay-blueprints`。
- GM 通过 `commit_turn` 创建 blueprint，之后继续工作并单独展示交接。
- Core 不认识 blueprint schema，GM/Writer 只读 projection。
- Validation 或第二 operation 失败时没有部分提交。
- Story snapshot 捕获 opaque blueprint payload；`/roll` 恢复前驱状态。
- `/roll` 推进 revision/branchEpoch；旧分支 receipt 不拦截 replacement branch。
- Snapshot 只在 Pi delivery completion 成功后创建。
- Writer 失败保留已成功 blueprint State commit，不创建 snapshot。
- P1 System runtime 有一个真实世界垂直切片并覆盖升级生命周期；RNG 抽卡探针与其他可选 capability 明确留到 P3。
