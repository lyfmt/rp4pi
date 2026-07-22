# System Registry、Namespaced Persistence 与 Migration 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:test-driven-development 逐个完成红绿循环，并使用 superpowers:executing-plans 执行本计划。若调度子代理，必须显式设置项目允许的 `model` 和 `reasoning_effort=medium`；工具不能同时设置时禁止调度。

**目标：** 建立 System module 作者 interface、不可变 registry、世界包模块加载、save-scoped opaque payload 持久化，以及初始化/逐版本迁移生命周期。

**架构：** `defineSystem()` 只定义 module-owned schema 与行为；`SystemRegistry` 校验名称、依赖和 capability 后冻结。SQLite 只保存 `(save_id, system_name, version, payload_json)`，`activateSystemSave()` 在独立 setup transaction 中初始化或迁移全部 namespace，失败时保留原始存档。

**P1 边界：** Registry 只验证 module 请求的 capability 是否有已注册 adapter；本计划不实现 RNG、jobs、audit 或 visibility adapter。P1 必须覆盖 capability 缺失时的启动失败，完整抽卡/RNG 探针留到 P3。

**技术栈：** TypeScript、Node 24、`node:sqlite`、Node test runner、现有 world loader。

---

## 前置条件

- 基线包含已批准规格：`docs/superpowers/specs/2026-07-10-system-extension-contract-design.md`。
- 本计划是 P1 的第 1 份计划，不依赖其他 P1 代码。
- 归档分支中的 `src/mechanisms/` 只作反例；不得复制 reducer、统一 entity kind 或中央事件协议。

## 文件结构

- 创建：`src/systems/types.ts`
  - 定义 JSON-compatible payload、`SystemDefinition`、command/projection author types。
- 创建：`src/systems/errors.ts`
  - 提供稳定 error code 与 `SystemRuntimeError`。
- 创建：`src/systems/define-system.ts`
  - 实现 `defineSystem()` 与 definition shape guard。
- 创建：`src/systems/registry.ts`
  - 校验名称、版本、command、依赖图和 capability，提供只读 lookup/order。
- 创建：`src/systems/module-loader.ts`
  - 从世界包声明的本地模块收集 `SystemDefinition` export。
- 创建：`src/systems/repository.ts`
  - 读写/list opaque versioned payload；不导出 repository port。
- 创建：`src/systems/activation.ts`
  - 新 namespace 初始化、旧版本迁移、未来版本拒绝和 setup transaction。
- 修改：`src/state/sqlite.ts`
  - 创建 `system_states` 表。
- 修改：`src/world/schema.ts`
  - 在 `LoadedWorld` 增加 `systemModulePaths`。
- 修改：`src/world/loader.ts`
  - 解析 `systems:` 路径列表，省略时归一化为空数组。
- 修改：`src/runtime/bootstrap.ts`
  - 加载 definitions，构造 registry 并放入共享 infrastructure；不执行 command。
- 修改：`worlds/_template/world.yaml`
  - 增加可选 `systems:` 注释示例。
- 修改：`skills/development-guide/references/world-pack.md`
  - 记录 System module 文件和 manifest 契约。
- 创建测试：`test/systems/definition.test.ts`
- 创建测试：`test/systems/registry.test.ts`
- 创建测试：`test/systems/repository.test.ts`
- 创建测试：`test/systems/activation.test.ts`
- 创建测试：`test/systems/module-loader.test.ts`
- 修改测试：`test/state/sqlite.test.ts`
- 修改测试：`test/world/loader.test.ts`

## 任务 1：固定 SystemDefinition Author Interface

**文件：**

- 创建：`src/systems/types.ts`
- 创建：`src/systems/errors.ts`
- 创建：`src/systems/define-system.ts`
- 测试：`test/systems/definition.test.ts`

- [ ] **步骤 1：编写失败测试，描述合法 definition**

```ts
test("defineSystem preserves module-owned lifecycle and freezes the definition", () => {
  const definition = defineSystem({
    name: "progression",
    version: 2,
    initialize: () => ({ level: 1, xp: 0, perks: [] }),
    parse: parseProgression,
    migrate: migrateProgression,
    commands: {},
    project: (_context, state) => state
  });

  assert.equal(definition.name, "progression");
  assert.equal(definition.version, 2);
  assert.deepEqual(definition.dependsOn, []);
  assert.deepEqual(definition.capabilities, []);
  assert.equal(Object.isFrozen(definition), true);
  assert.equal(Object.isFrozen(definition.commands), true);
  assert.equal(isSystemDefinition(definition), true);
});
```

- [ ] **步骤 2：增加非法名称、非正整数版本和非法/空 command key 测试**

名称只接受 `/^[a-z][a-z0-9-]*$/`。`defineSystem()` 对非法 author input 抛出：

```ts
new SystemRuntimeError("REGISTRATION_INVALID", {
  system: "Bad Name"
});
```

- [ ] **步骤 3：运行测试并确认红灯**

```bash
npm test -- test/systems/definition.test.ts
```

预期：FAIL，模块 `src/systems/define-system.ts` 尚不存在。

- [ ] **步骤 4：实现最少 author types 和 definition factory**

核心类型保持为：

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type SystemCommandContext = Readonly<{
  read(system: string): unknown;
  capability(name: string): unknown;
}>;

export type ProjectionAudience =
  | Readonly<{ kind: "gm" }>
  | Readonly<{ kind: "writer" }>
  | Readonly<{ kind: "player" }>
  | Readonly<{ kind: "system"; name: string }>;

export type ProjectionContext = Readonly<{
  audience: ProjectionAudience;
}>;

export type SystemCommandDefinition<State> = Readonly<{
  parseInput(input: unknown): unknown;
  execute(
    context: SystemCommandContext,
    state: Readonly<State>,
    input: unknown
  ): { nextState: unknown; result: unknown };
}>;

export type SystemDefinition<State> = Readonly<{
  name: string;
  version: number;
  dependsOn: readonly string[];
  capabilities: readonly string[];
  initialize(): unknown;
  parse(payload: unknown): State;
  migrate?: (fromVersion: number, payload: unknown) => { version: number; payload: unknown };
  commands: Readonly<Record<string, SystemCommandDefinition<State>>>;
  project(context: ProjectionContext, state: Readonly<State>): unknown;
}>;
```

`defineSystem()` 接受可省略的 `dependsOn`/`capabilities`，归一化为复制后的冻结空数组；同时复制并冻结 command map 与每个 command definition，避免 author input 在注册后改变。它只校验/freeze definition，不得连接 SQLite 或 Pi。

- [ ] **步骤 5：运行测试和 typecheck**

```bash
npm test -- test/systems/definition.test.ts
npm run typecheck
```

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add src/systems/types.ts src/systems/errors.ts src/systems/define-system.ts test/systems/definition.test.ts
git commit -m "feat(system): define module author contract"
```

## 任务 2：建立不可变 Registry

**文件：**

- 创建：`src/systems/registry.ts`
- 测试：`test/systems/registry.test.ts`

- [ ] **步骤 1：编写 lookup 与依赖顺序失败测试**

```ts
test("registry orders declared dependencies before dependants", () => {
  const registry = createSystemRegistry([questSystem, generatorSystem], {
    capabilities: new Map()
  });

  assert.deepEqual(registry.names(), ["generator", "quest"]);
  assert.equal(registry.require("quest"), questSystem);
});
```

其中 `questSystem.dependsOn = ["generator"]`。

- [ ] **步骤 2：编写注册失败矩阵**

覆盖：

- 同名 System module。
- 未注册依赖。
- 依赖环。
- 请求不存在 capability。
- `require("missing")` 返回 `SYSTEM_NOT_REGISTERED`，不返回 `undefined`。

- [ ] **步骤 3：运行测试并确认红灯**

```bash
npm test -- test/systems/registry.test.ts
```

预期：FAIL，`createSystemRegistry` 未定义。

- [ ] **步骤 4：实现拓扑排序和只读 registry**

公开 surface 仅保留：

```ts
export type SystemRegistry = {
  names(): readonly string[];
  definitions(): readonly SystemDefinition<unknown>[];
  require(name: string): SystemDefinition<unknown>;
  hasCapability(name: string): boolean;
};
```

不得提供运行期 `register()` 或可变 `Map`。

- [ ] **步骤 5：验证通过并提交**

```bash
npm test -- test/systems/registry.test.ts
npm run typecheck
git add src/systems/registry.ts test/systems/registry.test.ts
git commit -m "feat(system): validate immutable registry"
```

## 任务 3：持久化 Versioned Opaque Payload

**文件：**

- 修改：`src/state/sqlite.ts`
- 创建：`src/systems/repository.ts`
- 修改测试：`test/state/sqlite.test.ts`
- 创建测试：`test/systems/repository.test.ts`

- [ ] **步骤 1：先更新 schema 测试期望**

在 `initializeSchema creates all state tables` 的有序表名中加入 `system_states`，并新增：

```ts
test("system_states uses a save-scoped namespace key", () => {
  // 同一 system_name 可分别写入两个 save；同一 save/name upsert 不产生第二行。
});
```

- [ ] **步骤 2：运行 schema 测试并确认红灯**

```bash
npm test -- test/state/sqlite.test.ts
```

预期：FAIL，缺少 `system_states`。

- [ ] **步骤 3：创建表**

```sql
CREATE TABLE IF NOT EXISTS system_states (
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  system_name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (save_id, system_name)
);
```

- [ ] **步骤 4：编写 repository 红灯测试**

覆盖：

- `writeSystemState()` / `readSystemState()` 原样 round-trip `{ version, payload }`。
- `listSystemStates()` 按 `system_name` 排序。
- 外键阻止写入不存在 save。
- 返回值使用 `structuredClone`/JSON 解析，调用者修改后不影响数据库。

- [ ] **步骤 5：实现内部 repository 函数**

```ts
export type StoredSystemState = {
  name: string;
  version: number;
  payload: unknown;
};
```

仅导出具体 SQLite 函数，不创建 `SystemStateRepository` port。

- [ ] **步骤 6：运行测试并提交**

```bash
npm test -- test/state/sqlite.test.ts test/systems/repository.test.ts
npm run typecheck
git add src/state/sqlite.ts src/systems/repository.ts test/state/sqlite.test.ts test/systems/repository.test.ts
git commit -m "feat(system): persist namespaced state"
```

## 任务 4：实现原子初始化与 Migration

**文件：**

- 创建：`src/systems/activation.ts`
- 测试：`test/systems/activation.test.ts`

- [ ] **步骤 1：编写新 save 初始化红灯测试**

```ts
const activated = activateSystemSave({ db, saveId, registry });
assert.deepEqual(activated.get("progression"), {
  version: 2,
  state: { level: 1, xp: 0, perks: [] }
});
assert.deepEqual(readSystemState(db, saveId, "progression"), {
  name: "progression",
  version: 2,
  payload: { level: 1, xp: 0, perks: [] }
});
```

- [ ] **步骤 2：编写 migration 成功和失败测试**

成功：

```text
v1 { level: 2, xp: 50 }
-> migrate(1)
-> v2 { level: 2, xp: 50, perks: [] }
-> parse v2
-> persist v2
```

失败必须覆盖：

- migration 抛错。
- migration 返回相同/更低 version。
- 缺失 migration。
- 迁移后 parser 拒绝。
- 存储 v3、definition v2 时返回 `SYSTEM_VERSION_FUTURE`。
- 第二个 module 失败时，第一个 module 的初始化/迁移也不提交。
- 数据库含 registry 未注册 namespace 时返回 `DEPENDENCY_UNAVAILABLE`，原数据不变。

- [ ] **步骤 3：运行测试并确认红灯**

```bash
npm test -- test/systems/activation.test.ts
```

- [ ] **步骤 4：实现 setup transaction**

实现顺序：

```text
BEGIN IMMEDIATE
-> list persisted namespaces
-> reject unknown persisted namespace
-> registry dependency order:
   missing state -> initialize -> parse
   old version -> migrate until current -> parse
   current version -> parse
   future version -> fail
-> write every changed payload
-> COMMIT
```

任一错误执行 `ROLLBACK`，重新抛出保留 code/context 的 `SystemRuntimeError`。

- [ ] **步骤 5：验证数据库原始值确实保持**

不要只断言抛错；失败测试必须重新 `readSystemState()`，验证原始 v1 和其他 namespace 未变化。

- [ ] **步骤 6：运行测试并提交**

```bash
npm test -- test/systems/activation.test.ts test/systems/repository.test.ts
npm run typecheck
git add src/systems/activation.ts test/systems/activation.test.ts
git commit -m "feat(system): activate and migrate save state"
```

## 任务 5：从 World Pack 加载 System Module

**文件：**

- 修改：`src/world/schema.ts`
- 修改：`src/world/loader.ts`
- 创建：`src/systems/module-loader.ts`
- 修改测试：`test/world/loader.test.ts`
- 创建测试：`test/systems/module-loader.test.ts`

- [ ] **步骤 1：编写 world loader 红灯测试**

```ts
test("world systems resolve to absolute local module paths", () => {
  const world = loadWorldFromDir(writeWorld({
    systems: ["./systems/progression.ts"]
  }));
  assert.deepEqual(world.systemModulePaths, [join(world.root, "systems/progression.ts")]);
});

test("missing systems defaults to an empty list", () => {
  assert.deepEqual(loadWorldFromDir(root).systemModulePaths, []);
});
```

Malformed `systems`（非字符串数组）和缺失文件都必须在 world load/startup 阶段给出包含路径的错误。

- [ ] **步骤 2：运行 loader 测试并确认红灯**

```bash
npm test -- test/world/loader.test.ts
```

- [ ] **步骤 3：实现 `systems:` 解析**

`LoadedWorld` 增加：

```ts
systemModulePaths: string[];
```

`systems` 是 `world.yaml` 的直接字符串列表，不当作 YAML module mapping 展开。

- [ ] **步骤 4：编写 module export 扫描红灯测试**

临时 `.ts` module 导出 2 个 `defineSystem()` 结果，`loadSystemDefinitions()` 应按文件顺序、export key 顺序返回。覆盖：

- 文件没有 SystemDefinition export。
- 同一对象被多个 export 引用时只收集一次。
- 加载错误包含 module path。

- [ ] **步骤 5：实现本地 module loader**

复用 `src/tools/registry.ts` 的 `createRequire(import.meta.url)` 模式；只接受 `isSystemDefinition()` 为真的 export，不加载 Pi tool。

- [ ] **步骤 6：运行测试并提交**

```bash
npm test -- test/world/loader.test.ts test/systems/module-loader.test.ts
npm run typecheck
git add src/world/schema.ts src/world/loader.ts src/systems/module-loader.ts test/world/loader.test.ts test/systems/module-loader.test.ts
git commit -m "feat(system): load world system modules"
```

## 任务 6：接入 Bootstrap 并记录世界包契约

**文件：**

- 修改：`src/runtime/bootstrap.ts`
- 修改：`worlds/_template/world.yaml`
- 修改：`skills/development-guide/references/world-pack.md`
- 创建测试：`test/runtime/bootstrap-systems.test.ts`

- [ ] **步骤 1：编写 infrastructure 红灯测试**

使用临时 project root 和 `RP_SQLITE_PATH`，加载一个声明 progression module 的世界：

```ts
const infra = createRuntimeInfrastructure(projectRoot);
assert.deepEqual(infra.systemRegistry.names(), ["progression"]);
assert.equal(infra.systemRegistry.require("progression").version, 2);
```

本任务只构造 registry，不在没有 save 的 bootstrap 阶段调用 initialize/migrate。

- [ ] **步骤 2：运行测试并确认红灯**

```bash
npm test -- test/runtime/bootstrap-systems.test.ts
```

- [ ] **步骤 3：扩展 RuntimeInfrastructure**

```ts
export type RuntimeInfrastructure = {
  db: RpDatabase;
  stateStore: StateStore;
  systemRegistry: SystemRegistry;
  ovClient: OpenVikingClient | undefined;
  world: LoadedWorld;
};
```

构造顺序固定为：SQLite schema -> world -> System module load -> registry validation -> lore import -> existing services。

- [ ] **步骤 4：更新模板与 world-pack 指南**

模板只加入注释，不默认启用系统：

```yaml
# systems:
#   - ./systems/my-system.ts
```

指南说明：System module 导出 `defineSystem()` 结果；它不导出 Pi tool、不访问 SQLite，状态只通过 `commit_turn` operation 推进（该工具由后续计划实现）。

- [ ] **步骤 5：运行聚焦和全量验证**

```bash
npm test -- test/systems/*.test.ts test/world/loader.test.ts test/runtime/bootstrap-systems.test.ts test/state/sqlite.test.ts
npm run typecheck
npm test
git diff --check
```

预期：全部 PASS；现有世界未声明 `systems` 时行为不变。

- [ ] **步骤 6：提交**

```bash
git add src/runtime/bootstrap.ts worlds/_template/world.yaml skills/development-guide/references/world-pack.md test/runtime/bootstrap-systems.test.ts
git commit -m "feat(system): wire registry into bootstrap"
```

## 完成条件

- 世界包可以声明本地 System module，启动时完成定义/依赖/capability 校验。
- 新 namespace 初始化与旧 payload migration 在一个 setup transaction 中完成。
- Migration、parser 或第二个 module 失败时没有部分写入。
- 未来版本和未注册持久化 namespace 明确失败。
- SQLite 仍是 implementation detail；测试穿过 registry/activation interface，并使用真实临时 SQLite。
- 未安装 capability 时 module 在注册阶段失败；本计划不提供任何 capability 的占位实现或静默降级。
- 本计划没有实现 command batch、GM `commit_turn`、snapshot 扩展或任何可选 capability adapter。
