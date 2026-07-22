# Domain Runtime 回退与干净基线实现计划

> **面向 AI 代理的工作者：** 执行时使用独立 worktree，逐任务验证并频繁提交。任何移动 `master` 的操作都必须在最终人工确认后进行。

**目标：** 安全保留当前所有工作，把主线恢复为不含聚合式 `commit_turn`、mechanism axis 和 domain runtime foundation 的稳定 RP 基线，为重新设计系统扩展能力提供干净起点。

**架构：** 不在当前 `master` 上逐个反向修改，也不直接执行破坏性 reset。先归档现有分支和未提交工作，再从 mechanism/domain runtime 之前的稳定代码创建独立回退分支，定向撤销更早引入的中央事件与聚合式 `commit_turn`，清理活动文档，完整验证后再移动 `master` 引用。

**技术栈：** Git worktree、TypeScript、Node 24、Node test、现有 smoke scripts。

---

## 设计依据

- 规格：`docs/superpowers/specs/2026-07-10-turn-workflow-and-rollback-boundaries-design.md`
- `commit_turn` 是 GM 内部状态推进，可在同一次 GM 流程中多次调用。
- `submit_direction_packet` 只负责展示交接；只有成功渲染的故事正文形成 story snapshot。
- `/roll` 以 story snapshot 为边界，撤销一个故事回合内的全部状态推进。
- 本计划只建立干净基线，不实现新的系统扩展接口。

## 历史定位

执行命令需要精确提交，但判断必须基于下表的功能含义：

| 标签 | 提交 | 含义 |
| --- | --- | --- |
| `PRE_EXTENSION_BASE` | `d3d18a0` | mechanism/domain runtime 之前；已包含 lore、writer、world pack、hooks、subagents，但仍含错误聚合式 `commit_turn` |
| `CENTRAL_DOMAIN_EVENTS` | `be89d96` | 引入中央 `DomainEvent` parser |
| `AGGREGATE_COMMIT_TURN` | `14c5d5c` | 引入 events + direction + terminate 的聚合工具 |
| `CURRENT_MASTER` | `5dd0a53` | 当前 master，已包含 mechanism、ledger、command 和 projection |
| `DOMAIN_RUNTIME_NEXT` | `7128f6d` | 后续 feature 分支，继续加入 jobs、自动子代理、RNG、entity 和约束文档 |

`PRE_EXTENSION_BASE` 不是最终目标，只是构造材料。必须继续反向应用
`AGGREGATE_COMMIT_TURN` 和 `CENTRAL_DOMAIN_EVENTS`，才能得到语义正确的干净基线。

## 目标基线

| 保留 | 暂时移除 |
| --- | --- |
| world pack、prompts、writing、revision | 当前 `commit_turn` 工具实现 |
| save/latest state/story snapshots/`/roll` | `domain-events.ts` 中央事件协议 |
| `get_status`、`update_*`、初始化工具 | mechanism manifest/registry/reducer/projection |
| `submit_direction_packet` 与 writer | command runner/event ledger/projection engine |
| OpenViking memory、固定 lore | jobs/scheduler/自动 subagent runtime |
| 手动 subagents、角色轨迹、原有 hooks | domain RNG/entity registry/state layers |

## 文件范围

### 由历史反向变更恢复

- 修改：`src/runtime/session-entries.ts`
- 修改：`src/tools/registry.ts`
- 删除：`src/tools/state/commit-turn.ts`
- 删除：`src/tools/state/domain-events.ts`
- 修改：`src/tools/state/submit-direction-packet.ts`
- 修改：`src/tools/state/update-attribute.ts`
- 修改：`test/guards/tool-contract.test.ts`
- 修改：`test/runtime/session-entries.test.ts`
- 删除：`test/state/commit-turn.test.ts`
- 删除：`test/state/domain-events.test.ts`

### 新增回退约束

- 创建：`test/guards/turn-boundary.test.ts`
- 保留：`docs/superpowers/specs/2026-07-10-turn-workflow-and-rollback-boundaries-design.md`
- 保留：`docs/superpowers/plans/2026-07-10-domain-runtime-rollback.md`

### 清理活动文档和世界提示

- 修改：`docs/demo.md`
- 修改：`docs/design/lore-lookup.md`
- 修改：`docs/design/non-memory-mvp.md`
- 修改：`docs/design/openviking-mvp.md`
- 修改：`docs/superpowers/plans/2026-07-04-lore-lookup-and-domain-tools.md`
- 修改：`skills/build-rp-agent/SKILL.md`
- 修改：`skills/build-rp-agent/references/build-flow.md`
- 修改：`skills/build-rp-agent/references/methodology.md`
- 修改：`skills/build-rp-agent/references/module-guide.md`
- 修改：`skills/development-guide/references/world-pack.md`
- 修改：`skills/migrate-st-card/references/project-mapping.md`
- 修改：`skills/start-game/SKILL.md`
- 修改：`worlds/_template/prompts/gm.md`
- 修改：`worlds/border-station/lore/rules.yaml`
- 修改：`worlds/border-station/prompts/gm-output.md`
- 修改：`worlds/border-station/prompts/gm-tools.md`

## 任务 1：归档所有当前工作

**目的：** 在任何回退前保留当前 master、后续 feature 分支和主工作区未提交内容。Git stash 在多个 worktree 之间共享，本计划不用 stash。

- [ ] **步骤 1：记录前置状态**

```bash
git status --short --branch
git worktree list --porcelain
git remote -v
```

预期：主工作区当前位于 `master`，存在未提交修改；`feat/domain-runtime-foundation-next` 位于独立 worktree；当前没有 remote。

- [ ] **步骤 2：为已提交历史建立只读归档引用**

```bash
git branch archive/pre-extension-reset-master-20260710 master
git branch archive/pre-extension-reset-next-20260710 feat/domain-runtime-foundation-next
```

- [ ] **步骤 3：把主工作区未提交内容保存到独立归档分支**

```bash
git switch -c archive/pre-extension-reset-wip-20260710
git add -A
git commit -m "chore(archive): preserve pre-reset worktree"
```

该提交只用于防丢失，不允许合并到新基线。

- [ ] **步骤 4：验证三个归档入口可读取**

```bash
git show --stat --oneline archive/pre-extension-reset-master-20260710
git show --stat --oneline archive/pre-extension-reset-next-20260710
git show --stat --oneline archive/pre-extension-reset-wip-20260710
git status --short
```

预期：三个引用均存在；主工作区干净；不删除任何已有 worktree。

## 任务 2：创建独立的干净基线 worktree

**目的：** 回退工作与现有分支完全隔离，直到最终验收前不移动 `master`。

- [ ] **步骤 1：从 mechanism/domain runtime 之前的稳定点创建分支**

```bash
git worktree add -b rollback/clean-rp-baseline .worktrees/clean-rp-baseline d3d18a0
cd .worktrees/clean-rp-baseline
```

- [ ] **步骤 2：带回已经批准的规格和本计划**

先复用主工作区已经安装的依赖，避免在回退 worktree 中重新下载或生成 lockfile：

```bash
test -e node_modules || ln -s ../../node_modules node_modules
npm run typecheck
```

然后恢复规划文档：

```bash
git restore --source=archive/pre-extension-reset-wip-20260710 -- \
  docs/superpowers/specs/2026-07-10-turn-workflow-and-rollback-boundaries-design.md \
  docs/superpowers/plans/2026-07-10-domain-runtime-rollback.md
```

- [ ] **步骤 3：提交设计依据**

```bash
git add \
  docs/superpowers/specs/2026-07-10-turn-workflow-and-rollback-boundaries-design.md \
  docs/superpowers/plans/2026-07-10-domain-runtime-rollback.md
git commit -m "docs(runtime): define turn workflow and rollback boundary"
```

- [ ] **步骤 4：确认后续错误实现不在该分支祖先中**

```bash
git merge-base --is-ancestor 1405b24 HEAD
```

预期：退出码为 `1`，表示 mechanism axis 的首个提交不在新分支历史中。

## 任务 3：先增加回合工具边界的失败测试

**文件：**
- 创建：`test/guards/turn-boundary.test.ts`

- [ ] **步骤 1：编写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { registerAllTools } from "../../src/tools/registry.ts";
import type { ToolDefinition } from "../../src/types/pi.ts";

test("clean baseline exposes submit_direction_packet but not the removed aggregate commit_turn", () => {
  const registered: ToolDefinition[] = [];
  registerAllTools(
    { registerTool: (tool: ToolDefinition) => registered.push(tool) } as never,
    undefined,
    undefined,
    { include: ["core.state"], extra: [] }
  );

  const names = registered.map((tool) => tool.name);
  assert.ok(names.includes("submit_direction_packet"));
  assert.ok(!names.includes("commit_turn"));
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- test/guards/turn-boundary.test.ts
```

预期：FAIL，当前历史点仍注册聚合式 `commit_turn`。

## 任务 4：定向撤销中央事件和聚合式 `commit_turn`

**文件：** 使用“由历史反向变更恢复”列表中的源码和测试文件。

- [ ] **步骤 1：反向应用两个错误提交，不自动生成 revert commit**

```bash
git revert --no-commit 14c5d5c be89d96
```

顺序必须先撤销聚合工具，再撤销它依赖的中央事件 parser。

- [ ] **步骤 2：确认变更范围准确**

```bash
git status --short
git diff --cached --stat
git diff --cached --name-status
```

预期：

```text
M  src/runtime/session-entries.ts
M  src/tools/registry.ts
D  src/tools/state/commit-turn.ts
D  src/tools/state/domain-events.ts
M  src/tools/state/submit-direction-packet.ts
M  src/tools/state/update-attribute.ts
M  test/guards/tool-contract.test.ts
M  test/runtime/session-entries.test.ts
D  test/state/commit-turn.test.ts
D  test/state/domain-events.test.ts
?? test/guards/turn-boundary.test.ts
```

- [ ] **步骤 3：运行边界测试验证通过**

```bash
npm test -- test/guards/turn-boundary.test.ts test/guards/tool-contract.test.ts test/runtime/session-entries.test.ts
```

预期：PASS。

- [ ] **步骤 4：运行类型检查和基线测试**

```bash
npm run typecheck
npm test
```

预期：全部通过。该反向变更已在独立临时克隆中验证：typecheck 通过，原有 56 项测试全部通过；新增 guard 后预计至少 57 项通过。

- [ ] **步骤 5：提交运行时代码回退**

```bash
git add -A
git commit -m "revert(runtime): remove aggregate turn commit protocol"
```

## 任务 5：清理活动文档、技能和世界提示词

**目的：** 代码回退后不能继续让 GM 或世界作者学习旧协议。历史计划可保留，但必须明确标记已废弃部分。

- [ ] **步骤 1：确认旧语义仍广泛存在**

```bash
rg -n '\bcommit_turn\b' docs skills worlds \
  -g '!docs/superpowers/specs/2026-07-10-turn-workflow-and-rollback-boundaries-design.md' \
  -g '!docs/superpowers/plans/2026-07-10-domain-runtime-rollback.md'
```

预期：匹配 demo、设计文档、build/migration skills、模板 prompt 和 border-station prompt。

- [ ] **步骤 2：统一修改活动说明**

所有活动文档遵循以下临时基线：

```text
GM 使用现有 update_* 工具推进确定性状态
-> GM 使用 submit_direction_packet 提交玩家可见正文或直接回复
-> needsRender=true 的正文成功后记录 story snapshot
```

具体要求：

- 删除“`commit_turn` 同时写 events 并提交 direction”的说明。
- 删除“`submit_direction_packet` 只是兼容工具”的说明。
- 将 `submit_direction_packet` 恢复为唯一展示收口工具。
- facts/relationships 的未来写入入口标记为待新扩展设计，不伪装成已有能力。
- `docs/superpowers/plans/2026-07-04-lore-lookup-and-domain-tools.md` 顶部增加状态说明：lore/get_status 部分保留，domain events/聚合 `commit_turn` 部分已由本计划撤销。
- 不修改 `commit_turn_memory` 等 OpenViking 专有术语，它与 GM 工具无关。

- [ ] **步骤 3：确认活动说明不再暴露旧工具**

```bash
rg -n '\bcommit_turn\b' docs skills worlds \
  -g '!docs/superpowers/specs/2026-07-10-turn-workflow-and-rollback-boundaries-design.md' \
  -g '!docs/superpowers/plans/2026-07-10-domain-runtime-rollback.md' \
  -g '!docs/superpowers/plans/2026-07-04-lore-lookup-and-domain-tools.md'
```

预期：无输出。

- [ ] **步骤 4：运行与 prompt/world 文档相关的测试**

```bash
npm test -- \
  test/e2e/demo-flow.test.ts \
  test/runtime/extension-runtime.test.ts \
  test/world/writing-border-station.test.ts \
  test/world/loader.test.ts
```

- [ ] **步骤 5：提交文档与提示词清理**

```bash
git add docs skills worlds
git commit -m "docs(runtime): restore separate state and presentation flows"
```

## 任务 6：确认 mechanism/domain runtime 没有残留

- [ ] **步骤 1：检查源码目录和数据库 schema**

```bash
test ! -e src/mechanisms
test ! -e src/domain
test ! -e test/mechanisms
test ! -e test/domain
rg -n 'domain_event_ledger|domain_jobs|mechanismRegistry|MechanismModule|runDomainCommand' src extensions test worlds
```

预期：前三条成功；`rg` 无输出。

- [ ] **步骤 2：检查状态 schema 未携带本轮新增固定结构**

```bash
rg -n 'mechanisms:|layers:|rng:|entities:' src/state/schema.ts
```

预期：无输出。

- [ ] **步骤 3：检查工具面**

```bash
npm test -- test/guards/turn-boundary.test.ts test/guards/tool-contract.test.ts
```

预期：`submit_direction_packet` 存在，聚合式 `commit_turn` 不存在。

## 任务 7：隔离审查当前未提交工作，不整批移植

**目的：** 当前主工作区同时包含 renderer/progress/TUI、tool contract、forge-role 和旧 `commit_turn` 修改。它们不能作为一个整体进入干净基线。

- [ ] **步骤 1：生成按文件的差异清单**

```bash
git diff --name-status \
  archive/pre-extension-reset-master-20260710..archive/pre-extension-reset-wip-20260710
```

- [ ] **步骤 2：按下表分类**

| 分类 | 文件/主题 | 处理 |
| --- | --- | --- |
| 明确不移植 | `src/tools/state/commit-turn.ts`、`test/state/commit-turn.test.ts` | 基于已撤销协议 |
| 明确不移植 | 旧 domain runtime/mechanism 实现计划 | 只留在 archive 分支 |
| 单独评估 | direction packet/tool contract 调整 | 仅在不重新耦合 `commit_turn` 时另开变更 |
| 单独评估 | prose renderer、live progress、TUI text | 与回退解耦，另跑测试后独立移植 |
| 单独评估 | forge-role 修改 | 独立审查角色行为与测试 |

- [ ] **步骤 3：禁止整体 cherry-pick 归档 WIP**

本任务不产生代码提交。任何待移植项都必须有独立问题、测试和 commit。

## 任务 8：完整验证干净基线

- [ ] **步骤 1：静态验证**

```bash
npm run typecheck
```

- [ ] **步骤 2：完整测试**

```bash
npm test
```

预期：全部通过，无 skip/todo；预计至少 57 项测试。

- [ ] **步骤 3：基础 RP smoke**

```bash
RP_WORLD=border-station bash scripts/smoke-demo.sh
```

验收：

- 新游戏可初始化。
- `get_status` 和现有 `update_*` 工具可用。
- 固定 lore 可查询。
- GM 使用 `submit_direction_packet` 结束展示流程。
- writer 正文成功后形成 story snapshot。
- `/roll` 能恢复上一故事 snapshot 并重跑。

- [ ] **步骤 4：检查最终差异与历史**

```bash
git status --short
git log --oneline --decorate -8
git diff --stat d3d18a0..HEAD
```

预期：工作区干净；差异只包含两个定向撤销、回退 guard、规格/计划和文档语义清理。

## 任务 9：人工确认后替换 master

**硬性关卡：** 在执行以下步骤前，向用户展示：

- 归档分支名称和 HEAD。
- `rollback/clean-rp-baseline` 的提交列表。
- typecheck、完整测试、smoke 结果。
- 相对 `d3d18a0` 的最终 diff stat。

- [ ] **步骤 1：确认没有新增 remote 或已发布历史约束**

```bash
git remote -v
git branch -vv
```

若出现 remote 且当前历史已发布，停止；不要移动 `master`，改为另行制定保留公共历史的 revert/merge 方案。

- [ ] **步骤 2：在原主工作区移动 master 引用**

原主工作区此时应位于 `archive/pre-extension-reset-wip-20260710` 且干净：

```bash
git branch -f master rollback/clean-rp-baseline
git switch master
```

不使用 `git reset --hard`。

- [ ] **步骤 3：切换后复验**

```bash
git status --short --branch
npm run typecheck
npm test
```

- [ ] **步骤 4：保留恢复点**

在新的扩展设计完成并经过真实 RP smoke 前，不删除：

- `archive/pre-extension-reset-master-20260710`
- `archive/pre-extension-reset-next-20260710`
- `archive/pre-extension-reset-wip-20260710`
- 原 `feat/domain-runtime-foundation-next` worktree
- `rollback/clean-rp-baseline` worktree

## 任务 10：转入新的扩展能力设计

本任务只建立下一阶段入口，不实现代码。

- [ ] **步骤 1：从干净 master 创建设计分支**

```bash
git worktree add -b design/system-extension-contract .worktrees/system-extension-contract master
```

- [ ] **步骤 2：用三个系统检验新接口，而不是先设计统一领域模型**

| 探针 | 必须验证的问题 |
| --- | --- |
| 抽卡 | 资源扣除、保底、随机结果和物品发放能否由系统自己原子处理 |
| 生成系统 | 能否创建系统自有结构，而不受核心 entity kind 限制 |
| 可升级自定义系统 | 是否拥有 state version、validation 和 migration |

- [ ] **步骤 3：新规格必须回答的接口问题**

- 核心只提供哪些能力：save namespace、持久化、事务、生命周期和工具绑定。
- 系统模块如何拥有自己的 schema、初始化、迁移、读写和投影。
- 多个系统如何参与一次 GM 内部 `commit_turn`，且允许连续多次 commit。
- `commit_turn` 如何与 `submit_direction_packet` 保持完全独立。
- RNG、jobs、audit、visibility 是否作为可选 capability，而不是强制领域模型。
- `/roll` 如何恢复 story snapshot，从而撤销期间所有系统状态推进。

- [ ] **步骤 4：完成独立设计规格后再写实现计划**

新规格必须先经用户批准。未经批准，不创建新的 mechanism/domain runtime 代码。
