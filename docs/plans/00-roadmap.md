# RP Agent Scaffold 分阶段路线图

> **面向 AI 代理的工作者：** 本路线图只负责阶段拆分。执行具体阶段时，打开对应 `docs/plans/NN-*.md`，按复选框逐项完成。

**目标：** 以 `../template/tavern2agent` 的 pi-native evented runtime 方法论为基础，实现一个可跑通完整流程的通用 RP scaffold demo。

**当前阶段：** P1 System runtime、生成探针与升级验收已完成；P2 与 P3 尚未实现。当前状态以 [项目控制面](../design/project-control-plane.md) 为准。

**架构：** 先落项目骨架，再按耦合系统逐阶段接入：SQLite/state、GM/writer 两段式、OpenViking 记忆、slash commands 与 demo 验证。每一阶段都必须能独立验证，不把多个系统混在一次大改里。

**技术栈：** TypeScript、pi extension/tools/hooks、Node 24 `node:sqlite`、OpenViking HTTP API、Markdown prompt/schema。

---

## 已确认设计源

- `docs/design/non-memory-mvp.md`
- `docs/design/openviking-mvp.md`
- `docs/design/openviking-investigation.md`
- `../template/tavern2agent/SKILL.md`
- `../template/tavern2agent/references/pi-integration.md`
- `../template/tavern2agent/references/two-pass-rendering.md`
- `../template/tavern2agent/references/ts-engine.md`
- `../template/tavern2agent/references/tool-abstraction.md`

## 阶段拆分

| 阶段 | 计划书 | 目标 |
|---|---|---|
| 1 | `01-scaffold-skeleton.md` | 建立 tavern2agent 风格的 pi 项目骨架 |
| 2 | `02-state-sqlite.md` | 实现 SQLite save/state/snapshot/roll 基建 |
| 3 | `03-two-pass-runtime.md` | 实现 GM direction packet -> writer prose -> custom-message 流程 |
| 4 | `04-openviking-memory.md` | 接入 OV session commit、search/read、自定义 schema |
| 5 | `05-slash-commands.md` | 实现 `/status`、`/save`、`/load`、`/roll` |
| 6 | `06-demo-validation.md` | 固定 demo 世界，跑通完整闭环并验证 |

### 扩展轴（MVP 之后，按 `workflow.md` 预期形态推进）

| 轴 | 当前状态 | 剩余缺口 |
| --- | --- | --- |
| 声明式 hooks | 已实现 | 后台 jobs 不在当前 Hook 能力内 |
| NPC 角色能力 | 角色物化、动态角色和轨迹已实现 | 并发编排仍由 GM 提示词驱动，runtime 不强制 |
| Writer 写作指导与 revision | 已实现 | 三回合因果规划尚未实现 |
| 系统扩展 | P1 runtime、工具绑定、全量 snapshot/roll、`relay-blueprints` 生成探针与升级验收已实现 | RNG 抽卡探针、jobs、audit、visibility adapter 尚未实现 |

### 当前里程碑

| 优先级 | 方向 | 状态 | 入口 |
| --- | --- | --- | --- |
| P0 | 项目控制面 | 已建立 | `docs/design/project-control-plane.md` |
| P0 | 系统扩展契约 | 规格已批准 | `docs/superpowers/specs/2026-07-10-system-extension-contract-design.md` |
| P1 | 系统持久化、事务、`commit_turn`、snapshot/roll、生成与升级探针 | 已完成 | 见下方 P1 实现计划 |
| P2 | NPC 编排 runtime、Writer 三回合规划 | 尚未实现 | 分别规划 |
| P3 | RNG 抽卡探针、jobs、audit、visibility | 尚未实现 | 按系统需求选择性实现 |

### P1 实现计划

P1 已按以下依赖顺序完成：

1. [System Registry、Namespaced Persistence 与 Migration](../superpowers/plans/2026-07-10-system-registry-persistence-migration.md)
2. [System Transaction Runtime 与 Command Dispatch](../superpowers/plans/2026-07-10-system-transaction-command-runtime.md)
3. [GM `commit_turn` Tool 与 Pi Binding](../superpowers/plans/2026-07-10-gm-commit-turn-tool-binding.md)
4. [System Story Snapshot、Restore 与 `/roll`](../superpowers/plans/2026-07-10-system-story-snapshot-roll.md)
5. [首个 System Probe 垂直切片](../superpowers/plans/2026-07-10-first-system-probe-vertical-slice.md)

P1 不实现 RNG adapter。它以 `relay-blueprints` 生成系统垂直切片收口，并覆盖可升级自定义系统的 activation、command、snapshot migration 与 restore；抽卡与 RNG 的完整验收留到 P3。

## 阶段依赖

```text
01 骨架
  -> 02 SQLite/state
      -> 03 GM/writer 两段式
          -> 04 OpenViking 记忆
          -> 05 Slash commands
              -> 06 Demo 验证
```

`04` 依赖 `03`，因为 OV 只沉淀 writer 成功正文。`05` 依赖 `02`，因为 slash commands 读写 save/state。`06` 是全链路验收。

## 历史 MVP 不做范围

以下限制只描述最初 1-6 阶段的 MVP，不代表当前能力。

- 不做 CLI generator。
- 不做 SillyTavern card IR。
- 不做复杂 subagent。
- 不做 CodeAct。
- 不做 GM 直接写 OV。
- 不做 OV task 持久化。
- 不做跨 save roll。
- 不做自动 memory recall 注入。

## 实现纪律

- 保持工具清单稳定，不做运行时 toolset 切换。
- GM 状态写入只能走工具。
- Writer 不能写 state。
- Writer prose 不能进入 GM 上下文。
- OV 是最终一致长期记忆，不是确定性状态源。
- 每阶段结束都要运行对应验证命令，并记录结果。
