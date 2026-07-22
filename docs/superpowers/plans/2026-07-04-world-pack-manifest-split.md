# World Pack Manifest 拆分实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [x]`）语法来跟踪进度。

**目标：** 把 world pack 的领域配置从单一 `world.yaml` 拆成显式引用的多个 YAML 文件，同时保持运行时 `LoadedWorld` 接口不变。

**架构：** `world.yaml` 保留世界元信息与模块入口；loader 在解析前读取被引用的模块 YAML，并合并成现有 manifest 形状。旧的内联 manifest 继续兼容，模板和 `border-station` 改为拆分形态。

**技术栈：** TypeScript、`yaml`、Node test、现有 `src/world/loader.ts`。

---

## 文件结构

- 修改：`src/world/loader.ts`
  - 新增模块引用解析：`state: ./state.yaml`、`memory: ./memory.yaml` 等。
  - 路径相对 world root 解析；被引用模块必须是 YAML mapping 或 list。
  - 保持旧内联 mapping 支持，避免破坏测试临时世界与已有 world pack。
- 修改：`test/world/loader.test.ts`
  - 先增加拆分 manifest 的失败测试。
  - 覆盖模块路径相对 world root、`prompt_template` 仍在 root 可用、错误消息命名模块字段。
- 创建：`worlds/border-station/state.yaml`
- 创建：`worlds/border-station/prompts.yaml`
- 创建：`worlds/border-station/memory.yaml`
- 创建：`worlds/border-station/tools.yaml`
- 创建：`worlds/border-station/subagents.yaml`
- 创建：`worlds/border-station/writing.yaml`
- 创建：`worlds/border-station/revision.yaml`
- 创建：`worlds/border-station/hooks.yaml`
- 修改：`worlds/border-station/world.yaml`
  - 缩减为世界元信息 + 模块引用。
- 对 `worlds/_template/` 做同构拆分。
- 修改：`skills/development-guide/references/world-pack.md`
  - 说明 `world.yaml` 可以内联，也可以引用模块 YAML。
  - 推荐新 world 使用拆分形态。

## 任务 1：测试拆分 manifest 加载

**文件：**
- 修改：`test/world/loader.test.ts`

- [x] **步骤 1：编写失败测试**

新增测试 `loads a world whose sections are external yaml modules`：

```ts
test("loads a world whose sections are external yaml modules", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = writeSplitWorld(dir, "split");
    const world = loadWorldFromDir(root);
    assert.equal(world.name, "split");
    assert.equal(world.initialState.player.location, "split room");
    assert.deepEqual(world.memory.policy.memory_types, ["characters"]);
    assert.equal(world.gmPromptPaths[0], join(root, "prompts", "gm.md"));
    assert.equal(world.subagents[0].promptPath, join(root, "subagents", "helper", "agent.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [x] **步骤 2：运行测试验证失败**

```bash
npm test -- test/world/loader.test.ts
```

预期：FAIL，字段 `state` 或其他模块字段被当作 string 而非 mapping 时解析失败。

## 任务 2：实现模块引用解析

**文件：**
- 修改：`src/world/loader.ts`

- [x] **步骤 1：实现最小代码**

添加 helper：

```ts
const MODULE_FIELDS = ["state", "prompts", "prompt_template", "memory", "tools", "subagents", "hooks", "writing", "revision"] as const;
```

在 `loadWorldFromDir` 读取 `world.yaml` 后调用 `expandManifestModules(manifest, worldRoot)`。

规则：
- 如果字段值是 mapping 或 list，按旧逻辑原样使用。
- 如果字段值是 string，则按 world root 解析为 YAML 文件。
- 引用文件解析结果替换该字段。
- 引用文件必须存在且解析成非空 YAML。
- 错误消息包含字段名和文件路径。

- [x] **步骤 2：运行测试验证通过**

```bash
npm test -- test/world/loader.test.ts
```

预期：PASS。

## 任务 3：拆分示例世界与模板

**文件：**
- 修改：`worlds/border-station/world.yaml`
- 创建：`worlds/border-station/*.yaml`
- 修改：`worlds/_template/world.yaml`
- 创建：`worlds/_template/*.yaml`

- [x] **步骤 1：迁移 YAML 内容**

把现有同名段落移动到模块文件中；`world.yaml` 只保留：

```yaml
name: border-station
display_name: 边境驿站
description: ...
state: ./state.yaml
prompts: ./prompts.yaml
memory: ./memory.yaml
tools: ./tools.yaml
subagents: ./subagents.yaml
writing: ./writing.yaml
revision: ./revision.yaml
hooks: ./hooks.yaml
```

`_template` 同构，但保留模板注释。

- [x] **步骤 2：运行世界加载测试**

```bash
npm test -- test/world/loader.test.ts
```

预期：PASS，`border-station` 与 `_template` 都能加载。

## 任务 4：更新文档与全量验证

**文件：**
- 修改：`skills/development-guide/references/world-pack.md`

- [x] **步骤 1：更新文档**

说明推荐结构：

```text
world.yaml 只做入口；state.yaml / memory.yaml / hooks.yaml 等承载具体配置。
```

说明兼容规则：
- 旧内联写法仍支持。
- 新写法推荐显式引用。
- 所有引用路径相对 world root。

- [x] **步骤 2：运行验证**

```bash
npm run typecheck
npm test
```

预期：全部 PASS。
