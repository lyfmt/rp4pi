# 项目控制面

**文档状态：** 当前项目状态的权威入口

**基线：** 2026-07-10 Domain Runtime 回退后的干净 RP 基线

## 当前实现

| 模块 | 已实现 | 当前 interface |
| --- | --- | --- |
| 启动 | core、two-pass-render、OpenViking memory 三个扩展 | `start.sh` 的 3 个 `-e` 入口 |
| 世界包 | state、prompts、prompt_template、memory、lore、tools、systems、subagents、writing、revision、hooks；loader 契约收紧：未知顶层键直接拒绝，引用文件（模块 YAML、prompts.gm、memory.schemas、systems、lore.sources[].path、tools.extra）在加载期做存在性校验（writing 指导与 subagent persona 刻意延迟到读取时） | `world.yaml` 及其模块引用；`npm run validate-world`（CLI 入口 `scripts/validate-world.ts`） |
| 状态 | player、time、scene、attributes、facts、relationships | `get_status` 与窄粒度 `update_*` |
| System 扩展 | registry、namespaced state、activation/migration、transaction runtime、`commit_turn`、GM/Writer projection、`relay-blueprints` 生成 probe | `defineSystem()`、`commit_turn`、`get_status`、全量 story snapshot 与 `/roll` |
| Writer | direction packet、写作指导、初稿、风格增强、惯性与套话审查、有限重写 | `submit_direction_packet` |
| 渲染 | 回合活动挂件（阶段动画、writer/修订流式正文预览、记忆沉淀动态图标）+ 单行 working label；正文经 idle 投递；记忆沉淀追踪 OV 异步提取任务到真实完成（commit 只入队，挂件跨 pipeline_done 持续脉冲，✓ 带提取条数，超时/任务 API 不可达显示"状态未知"而非假 ✗；watcher 与排水链解耦、新回合与 shutdown 取消；widget key 所有权守卫防跨回合误清）；在途 story commit（投递→snapshot→turn_committed hook→OV 沉淀）在下一条输入与 session 关闭前强制排空 | `turn-activity-widget.ts`、`extraction-watch.ts`、`story-commit-tracker.ts`（`input` / `session_shutdown` 排水） |
| 存档 | save、session binding、latest state、最近 2 个完整确定性 story snapshot | `/save`、`/load`、`/roll` |
| 角色 | 世界角色、动态角色、角色轨迹 | GM 调用 `subagent`；runtime 不自动调度 |
| Hook | session_start、turn_start、turn_committed | inject、state、delegate |
| 记忆 | SQLite lore、OpenViking 最终一致记忆 | lookup/read 与 search/read |

## 当前实际链路

```text
玩家输入
-> GM 读取状态、资料和记忆
-> GM 按提示调用角色子代理并去除矛盾
-> GM 调用窄粒度 update_* 更新 Core，并按需多次调用 commit_turn 原子推进 System state
-> GM 调用 submit_direction_packet
-> Writer 生成、审查并修订正文（草稿与修订阶段流式预览到回合活动挂件）
-> Pi 接受正文投递
-> runtime 为 Core 与全部 System state 记录 story snapshot
-> Hook 与 OpenViking 处理后续工作
-> 在途 story commit 由排水点兜底（下一条输入前、session 关闭前），避免单发模式与连发输入丢投递
```

## 目标实现

```text
玩家输入
-> GM 读取核心与各系统状态
-> GM 编排角色子代理并消除冲突
-> GM 按需多次执行状态推进
-> GM 进行展示交接
-> Writer 完成规划、初稿、审查和修订
-> Pi 接受正文投递后，runtime 为核心与全部系统建立 story snapshot
-> Hook、记忆和可选后台能力继续处理
```

目标底座只提供 save namespace、持久化、事务、生命周期、工具绑定和 snapshot/restore。System module 自行拥有 schema、初始化、迁移、读写和投影。

## 当前缺口

- facts/relationships 有数据结构，但没有通用写入入口。
- 多次 `update_*` 之间没有原子事务。
- NPC 并发委派是提示词约定，不是 runtime 编排保证。
- 三回合因果规划只存在于目标流程，没有进入实际 Writer pipeline。
- RNG 抽卡探针、jobs、audit、visibility adapter 尚未实现。

## 已确认约束

- 状态推进与展示交接必须分离。
- 同一次 GM 流程允许多次状态推进。
- Writer 不写确定性状态。
- Writer 失败不撤销已经完成的状态推进，也不创建成功故事 snapshot。
- OpenViking 失败不回滚故事回合。
- `/roll` 以故事回合为单位，不以单次状态推进为单位。
- State commit revision 单调递增；`/roll` 成功时推进 revision 与 branch epoch，旧分支 receipt 不得命中新分支。
- Story snapshot 只能在 Pi 接受正文投递后创建；排队、超时或 session 失效不算成功交付。
- Existing save 的 core-only snapshot 以当前完整确定性状态升级为基线，不猜测旧角色或轨迹历史。

## 文档权威顺序

1. 当前源码与自动化测试。
2. [`docs/superpowers/specs/2026-07-10-system-extension-contract-design.md`](../superpowers/specs/2026-07-10-system-extension-contract-design.md)。
3. `docs/superpowers/specs/2026-07-10-turn-workflow-and-rollback-boundaries-design.md`。
4. `docs/superpowers/plans/2026-07-10-domain-runtime-rollback.md` 的任务 10。
5. `workflow.md` 与 `docs/plans/00-roadmap.md`。

发生矛盾时，高优先级来源覆盖低优先级来源；修复实现或文档后，必须在同一变更中同步本文件。

## 当前里程碑

| 优先级 | 里程碑 | 状态 |
| --- | --- | --- |
| P0 | 项目控制面 | 已建立 |
| P0 | [系统扩展契约](../superpowers/specs/2026-07-10-system-extension-contract-design.md) | 规格已批准 |
| P1 | namespaced persistence、transaction、`commit_turn`、全量 snapshot/roll、生成与升级探针 | 已完成 |
| P2 | NPC 编排 runtime、Writer 三回合规划 | 尚未实现 |
| P3 | RNG 抽卡探针、jobs、audit、visibility | 尚未实现 |

### P1 实现计划

P1 已按以下依赖顺序完成：

1. [System Registry、Namespaced Persistence 与 Migration](../superpowers/plans/2026-07-10-system-registry-persistence-migration.md)
2. [System Transaction Runtime 与 Command Dispatch](../superpowers/plans/2026-07-10-system-transaction-command-runtime.md)
3. [GM `commit_turn` Tool 与 Pi Binding](../superpowers/plans/2026-07-10-gm-commit-turn-tool-binding.md)
4. [System Story Snapshot、Restore 与 `/roll`](../superpowers/plans/2026-07-10-system-story-snapshot-roll.md)
5. [首个 System Probe 垂直切片](../superpowers/plans/2026-07-10-first-system-probe-vertical-slice.md)

P1 以 `relay-blueprints` 生成系统真实垂直切片收口；可升级自定义系统的 activation、command、snapshot migration 与 restore 验收已由前四份计划覆盖。抽卡与 RNG capability 的完整端到端验收属于 P3。

## 恢复点

旧实现只作为只读材料保存在以下分支（**仅维护者本地可用，未推送远端**，公开 clone 中无法访问）：

- `archive/pre-extension-reset-master-20260710`
- `archive/pre-extension-reset-next-20260710`
- `archive/pre-extension-reset-wip-20260710`
- `feat/domain-runtime-foundation-next`

禁止整体 cherry-pick；任何复用都必须按独立主题重新审查和测试。

## 维护规则

- runtime 能力增删时，同一变更必须更新“当前实现”和“当前缺口”。
- 规格获批时更新“目标实现”和“当前里程碑”。
- `workflow.md` 只描述目标体验，不用它证明功能已经实现。
- `docs/plans/00-roadmap.md` 记录阶段状态，不重复本文件的完整能力矩阵。
