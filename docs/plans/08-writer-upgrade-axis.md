# Writer 升级轴（B 线）—— 实现交接文档

> 目标：按 `workflow.md` 的 Step_4 / Step_5 / Step_7，把当前"单次 `complete()` 调用"的 writer 升级为一个**承载声明式写作指导、会做 3 回合因果规划、并强制自检修订**的多步 writer。让玩家可见正文的质量对齐预期形态。
>
> **历史状态：** 本文档记录当时的 Writer B 线执行计划，并基于当时已有的 `characterActions` 通道继续开发；它不代表当前 runtime 强制执行 NPC 并发编排。当前状态以 [项目控制面](../design/project-control-plane.md) 为准。

---

## 1. 已和用户确认的方向（拍板决策，勿再动摇）

用户 2026/07/03 明确选定：

- **先做 A 线（已完成），再做 B 线（本文档）。**
- **写作指导来源 = 世界包新增 `writing:` 轴**（world.yaml 声明式，与已完成的 `subagents:` / `hooks:` 轴同范式：世界只声明，底座提供机制）。
- **Writer 形态 = 一个"完整的 agent"**——用户 2026/07/03 进一步明确：writer 不是被动的正文生成器，而是一个**能自己自由调工具的完整 agent**，至少能：**lookup the world**（查世界/长期记忆）、**read skill**（读写作指导等技能）、**get status**（读当前世界状态）。它自主决定何时查什么，再据此规划、落稿、自检修订。

> ✅ 可行性已确认（见 §4）：pi-ai `complete()` 原生支持 `tools` 与 tool-call ⇒ 可在 Pass B **自建一个真正的 agent 工具循环**（complete → 派发工具 → 回灌 tool_result → 循环 → 定稿），无需 pi-subagents 的"loop 外 spawn"。writer 拿到的是一套**只读工具**（永不写 state、永不 submit）。"多步自检修订"从"硬编码管道"变成"agent 在其工作流里自主完成"——我们的 Pass B 代码只负责跑这个工具循环直到产出最终正文。

---

## 2. workflow.md 对应关系（B 线要补的三步）

```
Step_4: 按需读取写作指导（写作风格、对话指导、成人场景指导等）   ← writing 轴
   ▼
Step_5: 汇总分析，设计 3 回合新剧情（严格"因为…→所以…"逻辑链）   ← 多步 writer：规划步
   ▼
Step_6: 撰写正文初稿（认知迷雾、真实人性等原则）                 ← 多步 writer：初稿步
   ▼
Step_7: 强制自检修订（对照写作指导、篇幅、格式、剧情逻辑）        ← 多步 writer：自检循环
   ├── 发现问题 → 一次性修补 → 返回 Step_7 再检查
   └── 无问题 → 输出
```

Step_1~3（回顾状态 / 分析场景 / NPC 编排）与 Step_8（OV 沉淀 + hook 演化）已由现有实现 + A 线覆盖，**B 线不碰**。

---

## 3. 现状：接手前你继承的东西

### 两段式 runtime（不要打破）

- **Pass A** = GM agent loop；`submit_direction_packet`（`terminate:true`）结束它。
- **Pass B** = `agent_end` 钩子（GM loop 已停）里渲染。故意在 `agent_end` 而非 loop 中途渲染——loop 中途投递正文会重新触发 GM 循环（"writer 输出后 GM 又接着干活"的 bug）。**升级后的多步 writer 仍必须整体待在 Pass B。**

### 关键文件

| 文件 | 作用 | B 线是否改 |
|---|---|---|
| `src/runtime/turn-hook.ts` | `createAgentEndHandler`：Pass B 入口。找到 pending packet → `commitTurn` → idle 投递 → emit turn-rendered | 一般不改 |
| `src/runtime/turn-commit.ts` | `commitTurn`：`writerClient.render(buildWriterMessages(...))` → 写 custom message → 落 snapshot | 可能不改（render 内部升级即可） |
| `src/runtime/writer-client.ts` | `createConfiguredWriterClient({projectRoot, ctx})`：读**全局** `.pi/agents/writer.md` 当 system prompt、读 `.pi/agent/settings.json` 的 writer model、**单次** `complete()`、`stripWriterThinking` + `extractWriterProse(<content>)` | **主战场** |
| `src/runtime/writer-history.ts` | `buildWriterMessages(history, packet)`：拼历史正文 + 当前 storyElements（A 线已加 `Character actions (authoritative…)` 段） | 可能加"规划"消息段 |
| `.pi/agents/writer.md` | writer system prompt（当前 8 行，全局、gitignore `!writer.md` 保留手写） | **改**（加自检纪律骨架） |
| `extensions/two-pass-render/index.ts` | 装 `agent_end`；`createWriterClient: (ctx) => createConfiguredWriterClient({projectRoot, ctx})`。**`getRuntimeInfrastructure` 已能拿到 `world`**（当前只解构了 db/stateStore） | **改**（把 world / 写作指导传进 writer client） |
| `src/world/schema.ts` | `LoadedWorld`（含 `gmPromptPaths: string[]`）、各 Spec 类型 | **加** `writingGuidePaths`（或结构化 spec） |
| `src/world/loader.ts` | `parsePromptPaths`(L163) 是 `prompts.gm` → 绝对路径列表的范本；`parseSubagents`/`parseHooks` 是结构化解析范本 | **加** `parseWriting` |

### A 线已交付、B 线要利用的通道

- direction packet 的 `storyElements.characterActions: {name,action}[]` 已把 role 子代理去矛盾后的产出送进 writer 输入（`writer-history.ts` 的 `formatCharacterActions`）。**多步 writer 的规划步/初稿步都应把它当角色行为的权威来源。**

### 写作指导当前来源的坑

- writer 的 system prompt **来自全局 `.pi/agents/writer.md`，不来自世界包**。而 `writing:` 轴要让**世界**声明指导。所以 W-B 必须把世界声明的指导**叠加**到 writer system prompt 上（或作为独立 system 段/规划输入）。writer.md 保持"底座通用骨架"，世界指导叠在其上——和 GM prompt（世界声明）vs 底座工具的分工一致。

---

## 4. 关键技术查证（实现前必读，已替你查过）

1. **pi-subagents 无编程式 spawn API**：它是个 pi 扩展（`src/extension/index.ts`），作用是把 `subagent` 工具挂进它所加载的 agent loop（即 GM 的前台 loop）。它**不导出**可在 Pass B 直接调用的 `runSubagent()` 之类函数。故 writer 在 `agent_end`（GM loop 外）**无法直接用 pi-subagents 机制 spawn 子进程**——`memory/hooks-axis-feature.md` 里的"loop 外自主 spawn 是后续大工程"的同一约束。**所以不走这条路。**
2. **pi-ai 无高层 agent runner，但 `complete()` 支持工具**：`@earendil-works/pi-ai` 无现成的"带工具循环的 agent 执行器"，但 `complete()` 的 `Context` 类型含 `tools?: Tool[]`（`dist/types.d.ts:239`），且有完整 tool-call 事件协议（`AssistantMessageEventStream` / `fauxToolCall`）。`Tool = { name, description, parameters: TSchema }`。⇒ **可以自建一个最小 agent 工具循环**：`complete(systemPrompt, messages, {tools})` → 若返回含 tool_use，本地派发对应工具、把 tool_result 追加进 messages → 再 `complete()` → 直到返回纯文本（正文）。
3. **结论（推荐路径，已可行）**：writer = **Pass B 内自建的工具型 agent**。一个循环跑 `complete()` + 只读工具集，agent 自主 lookup/read/get-status，按其被指示的工作流（规划→初稿→自检修订）产出，最终纯文本即玩家可见正文。完整落地用户要的"完整 agent 形态"，且自足、不依赖 loop 外 spawn。字面"真 pi-subagents 子进程"不需要、也做不到（Pass B 在 GM loop 外）。

### writer 的只读工具集（复用现成实现，最小权限）

| 能力（用户要求） | 复用 | 备注 |
|---|---|---|
| **lookup the world** | `src/tools/lookup/search-memory.ts`、`read-memory.ts`（`search_memory` / `read_memory`，OV 支持） | 已是 `ToolDefinition`；OV 不可达时须优雅降级（和 GM 侧一致） |
| **read skill** | `writing:` 轴的写作指导文件（W-A/W-B）；可做一个 `read_writing_guide` 只读工具按 kind 取指导 | "按需读取"（workflow.md Step_4）天然由 agent 自主调用满足，比全量注入更贴切 |
| **get status** | `src/state/status.ts` 的 `formatStatus(stateStore.getState())`（现被 `/status` 命令用） | 包一个只读 `get_status` 工具即可；也可给 `read_trajectory`/`read_characters` 视需要 |

> ⚠️ 工具集**必须全只读**：不含任何 `update_*` / `initialize_new_game` / `submit_direction_packet`。writer 永不写 state、永不收口回合。这些工具的 `execute` 用共享 bootstrap 的 db/stateStore/ovClient（与 GM 侧同源），但只读路径。
>
> ⚠️ "read skill 读技能" 的确切范围要与用户确认：是仅"写作指导"（`writing:` 轴），还是也包括 `skills/` 下的技能文件（如成人场景指导若做成 skill）。见 §5 决策点。

---

## 5. 分阶段实现（建议 W-A ~ W-E，每阶段可 review、全绿再进）

### W-A：`writing:` 契约 + loader

- `src/world/schema.ts`：加写作指导声明。**建议结构化**（对齐 workflow.md "写作风格、对话指导、成人场景指导等"）：
  ```ts
  export type WritingGuideSpec = {
    /** 分类 slug，如 style / dialogue / adult；世界内唯一。 */
    kind: string;
    /** 指导正文文件的绝对路径。 */
    path: string;
    /** 可选：仅在满足条件时注入（"按需"）。MVP 可先不做，全量注入。 */
    when?: string;
  };
  ```
  `LoadedWorld` 加 `writingGuides: WritingGuideSpec[]`（或最简版 `writingGuidePaths: string[]`，若决定不分类）。
- `src/world/loader.ts`：加 `parseWriting(manifest.writing, worldRoot)`，照抄 `parsePromptPaths`(L163) + `parseSubagents`(L211) 的校验风格（slug 唯一、字符串必填、路径 `resolveRelative`，**只做结构化校验、不查文件存在性**——存在性在 W-B 读取时报错，与 subagents 轴一致）。接进 `loadWorldFromDir` 的返回对象。
- 测试：`test/world/writing-loader.test.ts`（合法解析 + 重复 kind/缺字段/空列表报错）。
- **决策点（问用户）**：`writing:` 是"全量注入"还是 workflow.md 说的"**按需**读取"（如成人指导仅在成人场景注入）。MVP 建议全量注入 + 预留 `when` 字段，把条件注入标为后续。

### W-B：writer 接入世界写作指导

- `createConfiguredWriterClient` 增参：接收 `world`（或直接 `writingGuides`）。把各指导文件读出、拼进 writer 的 system prompt（在 `.pi/agents/writer.md` 骨架之后追加"# 本世界写作指导"段）。
- `extensions/two-pass-render/index.ts`：`getRuntimeInfrastructure` 解构出 `world`，传给 `createConfiguredWriterClient({ projectRoot, ctx, world })`。
- 测试：注入 fake `completeText`，断言 system prompt 含世界指导文本；无 `writing:` 的世界不受影响（向后兼容）。

### W-C：agent 化 writer（自建工具循环 + 规划/自检工作流）—— 核心

把 `WriterClient.render` 从"单次 `complete()`"改为一个**自建的最小 agent 工具循环**（全部在 Pass B）：

1. **构造只读工具集**（§4 表）：`search_memory` / `read_memory` / `get_status` / `read_writing_guide`（+ 视需要 `read_trajectory` 等）。转成 pi-ai `Tool[]`（`{name, description, parameters}`）。工具 `execute` 走共享 bootstrap 的 db/stateStore/ovClient，**只读**。
2. **循环**：
   ```
   messages = [初始 user 消息：storyElements + characterActions + 指令]
   for i in 0..MAX_STEPS:
     resp = complete(systemPrompt=writer.md+世界写作指导, messages, { tools })
     if resp 含 tool_use:
        为每个 tool_use 本地派发对应只读工具，得到 tool_result
        messages.push(assistant(resp), toolResults)
        continue
     else:                       # 纯文本 = 定稿正文
        return extractWriterProse(stripWriterThinking(resp.text))
   # 触顶保护：达到 MAX_STEPS 仍未定稿，用最后一次文本兜底
   ```
3. **工作流由 system prompt 指示**（不是硬编码管道）：writer.md 要求 agent 依次做——分析场景 → 视需要 lookup world / read skill / get status → 设计 3 回合因果链（Step_5，"因为…→所以…"，**内部推理，不写进正文**）→ 落初稿（Step_6）→ 对照写作指导/篇幅/格式/逻辑自检修订（Step_7）→ 输出最终正文。agent 自主决定调哪些工具、调几次。
- **`MAX_STEPS` 迭代上限必须存在**（如 8~12 步，含工具往返）防止无限循环耗 token。
- 复用现有 `stripWriterThinking` + `extractWriterProse(<content>)` 抽最终正文。
- 保持不变式：工具全只读；agent 的中间推理/工具往返**不进玩家正文、不进 GM 上下文**（只有最终 prose 经 `commitTurn` 落 custom message）。
- 测试：注入可编程 fake `completeText`（先返回一个 tool_use、再返回纯文本），验证——①工具被派发且 tool_result 回灌 ②循环在纯文本处收敛定稿 ③触顶兜底 ④中间态不出现在最终 prose。

> ⚠️ 成本：agent 循环 = 每回合多次模型调用 + 工具往返。writer model 仍读 `.pi/agent/settings.json` 的 `writer` 段（部署配置，不进世界包）。`MAX_STEPS` 与只读工具集是两条硬护栏。
> ⚠️ 现有 `writer-client.ts` 的 `completeText` 注入点（`defaultCompleteText` 用 `complete()`）要扩成能传 `tools` 并解析 tool_use；测试的 fake 也按新签名。

### W-D：border-station 范例 + writer.md 强化

- `worlds/border-station/` 加 `writing/` 指导文件（如 `style.md` / `dialogue.md`；`adult.md` 视世界基调可选）+ world.yaml 的 `writing:` 段声明。
- `.pi/agents/writer.md`：加"三步纪律"骨架（规划→初稿→自检；自检清单：篇幅/格式/因果链/是否泄漏字段名/是否越权替未列出角色发言）。参考 A 线已加的"依据 Character actions 落笔、不另编矛盾言行"。

### W-E：文档 + `_template`

- `skills/development-guide/references/world-pack.md`：加「Writing」大节（`writing:` 字段、分类、全量 vs 按需、与 writer 多步流程的关系）+ manifest 表加 `writing` 行。
- `worlds/_template/`：world.yaml 加 `writing:` 注释骨架 + `writing/` 指导文件骨架（`cp -r` 即用）。

---

## 6. 关键约束（勿违背）

- **Writer 绝不写 state**——状态只经工具写。多步的任何一步都不例外。
- **Writer prose / 中间态绝不进 GM 上下文**——`context-filter.ts` 已挡 `writer-prose` custom message；规划/自检的中间文本不得作为持久 entry 泄漏。
- **渲染整体留在 `agent_end`（Pass B）**——不得在 GM loop 内触发（否则 GM 续跑 bug）。
- **自检循环必须有迭代上限**——防无限修订。
- **writer model 读 `.pi/agent/settings.json`**——连接/模型是部署配置，不进世界包；世界包只声明"写什么/怎么写"（写作指导）。
- **成人场景指导是世界包声明的可选内容**——底座不预设立场，只提供注入机制。
- **不改 commit / turn-rendered 时序**——OV 沉淀（Step_8）与 hooks（turn_committed）仍订阅**最终** prose 的 turn-rendered 事件；多步只改"如何产出 prose"，`commitTurn` 落 snapshot + emit 事件的时序保持不变。
- **向后兼容**：无 `writing:` 段的世界、以及只想要单步 writer 的场景，行为不能退化（A 线之前的 232 + A 线 3 = 235 测试须持续全绿）。

---

## 7. 验证命令

```bash
npm run typecheck
node --test                 # 全套（当前 235 绿，B 线每阶段后须保持全绿）
bash scripts/smoke-demo.sh  # 推荐入口：typecheck + test + start.sh 可执行 + OV smoke（不可达则 SKIP）
```

> live 验证（真 provider 多步渲染）留到 W-C 后可选做；跑法参考 `memory/subagent-feature.md` 的 live 小节（`pi ... -e core -e two-pass-render -e openviking-memory -p "<输入>"`）。静态 + fake-writer e2e 是每阶段的必过门槛。

---

## 8. 相关索引

- 预期形态：`workflow.md`（项目根，Step_4/5/6/7）。
- 上游 A 线：`memory/npc-orchestration-axis.md`（characterActions 通道，B 线复用）。
- 同范式参考：`memory/subagent-feature.md`、`memory/hooks-axis-feature.md`（声明式世界包轴：schema→loader→物化/接线→范例→文档）。
- 交接文档风格范本：`docs/plans/07-hooks-axis.md`。
- 未 commit 到 git；当前分支 master。
