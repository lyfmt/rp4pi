# 09 · Prompt 模板轴（GM / Writer prompt 可被世界包自定义）

> 交接文档。承接 07-hooks-axis / 08-writer-upgrade-axis 的「声明式轴」范式。
> 读者：下一个实现此轴的 agent。**先通读全篇再动手**，尤其「不做什么」与「验收」两节。

> 实施状态：已落地到 `prompt-template-axis` 分支。`MEMORY.md` 索引更新未执行：当前仓库不存在 `MEMORY.md` 或 `docs/MEMORY.md`。

## 0.5 决策记录（与实现者对齐后敲定，覆盖下文旧默认）

这几条是核对源码后与作者敲定的取舍，**优先级高于本文其余小节里的初版描述**——下文相关段落已按这里改写：

- **D1 · 装配器放在 `render` 内，`render` 换签名。** 现状 `messages` 由 `turn-commit.ts:46` 在 render *之前* 用 `buildWriterMessages` 造好，而 `systemPrompt` 在 render *内部* 造。模板要同时掌控这两者的顺序，就必须同时拿到原始 `history` 与 `packet`。因此 **`render` 不再收造好的 `messages[]`，改收 `{ history, packet }`**（模板从 `world.promptTemplates.writer` 经 client 闭包捕获，不走 render 入参）。装配、systemPrompt 拼装、revision 显式入参全部收敛在 render 内。代价：`turn-commit.ts` 调用点 + `writer-client.test.ts` 十余处 `render([...])` 全部改签名——这是本轴改动量最大的一处，落地顺序里先做「无模板等价回归」测试锁住行为再改。
- **D2 · 全局 `writer.md` 降级为一个 marker：`writer_base`。** `writer.md` 含**输出契约**（`<content>` 包裹、因果链要求），`extractWriterProse` 依赖它；若「模板接管即不注入 writer.md」，作者漏写契约会让 writer 直接产不出正文。故把 writer.md 变成 **writer 的一个 marker `writer_base`**：作者在模板里显式放它才注入，既保留「persona 可被世界替换」（不放 writer_base，自带 persona），又让老实作者一行 `{marker: writer_base}` 就白拿到底座的输出契约。`writer_base` 与 `writing_guides` 都是 **system 去向**（见 §2.1 新增列）。
- **D3 · 有 gm 模板时 `prompts.gm` 可缺省。** `loader.ts:parsePromptPaths` 现强制 `prompts.gm` 非空；有 gm 模板时模板负责全部 system，再逼作者写一份不经 `resources_discover` 生效的 `prompts.gm` 是噪音。故：**声明了 `prompt_template.gm` ⇒ `prompts.gm` 可省（省则 `gmPromptPaths=[]`）；未声明 ⇒ 维持强制非空**。实现上 loader 需先解析 `prompt_template` 再据此放宽 `parsePromptPaths` 的校验。

核对出的三个运行时事实（实现时会踩，先记下）：

- **`WriterMessage` 有两份定义**：`writer-client.ts:6`（`user|assistant|system`）与 `writer-history.ts:6`（`user|assistant`）。装配改造需统一它们（system 只会被上提成 systemPrompt，不会进 messages）。
- **`PiAiMessage` 联合没有 `system` 角色**（`writer-client.ts:69-95`）——这是 §5.1「system 上提到 systemPrompt 字段」被类型逼出的根因，不是可选优化。
- **GM 侧 `RuntimeMessage.role` 是 `string`**（`prose-message.ts:4`），类型上塞 `system` 不报错，但 **pi 是否接受 `context` 返回里夹 `role:"system"` 无法从类型确认**，是运行时契约风险；§5.2 落地前必须实测，不成则 GM 模板的 `system` entry 也走「上提/改用 user 角色」策略。

## 0. 一句话目标

让世界包能**自定义 GM 与 Writer 的 prompt 组装方式**——把 prompt 从「一堆 system 段」升级成
**有序、带 role（system/user/assistant）的消息链**，允许作者像 SillyTavern 那样
**伪造 user/assistant 对话链路**（few-shot 对话、越狱前缀、角色开场白等）。

底座**只提供机制（模板装配器 + marker 展开），绝不内置任何具体 prompt 内容**。
世界不声明模板时，行为与现在**完全一致**（向后兼容）。

## 1. 为什么要做 / 现状缺口

现状（已核对源码）：

- **GM 侧**：prompt 只有 `world.gmPromptPaths`，经 `resources_discover` 交给 pi，pi 把这些
  md **全部当 system 角色**拼接（`extensions/core.ts:54-61`）。真正的 user/assistant 对话链
  由 **pi 自己管理的 session 历史**产生，世界包碰不到。→ **作者只能写 system 段，无法插入伪造对话。**
- **Writer 侧**：消息链由我们在 `src/runtime/writer-history.ts:buildWriterMessages` **硬编码**构造
  （system = `.pi/agents/writer.md` + 写作指导目录；user/assistant = 机械拼的历史摘要 + 当前 packet）。
  结构写死在代码里，**世界包没有任何入口改它**；`writer.md` 还是全局文件，一改所有世界都变，
  与「世界包可替换」的底座定位冲突。

结论：**「prompt 可被世界自定义为角色化消息链」这个入口，GM 和 writer 都没有开。** 本轴补上。

## 2. 设计（与现有轴同构）

在 `world.yaml` 新增一段声明式 **`prompt_template`**，GM 与 writer 各一份、结构相同：
**一个有序的 entry 列表**，每个 entry 二选一：

- **字面消息** `{ role, content | path }`：`role ∈ system|user|assistant`；`content` 写死文本，
  或 `path` 指向一个 md 文件（二选一，均相对世界目录解析为绝对路径）。
  → **这就是「伪造对话」能力**：作者想插几轮 fake user/assistant 都行。
- **标记（marker）** `{ marker: <name> }`：底座在这个位置**展开真实运行内容**。

底座装配器职责：**按顺序遍历 entry**，字面的原样发出，marker 的展开成真实消息，拼成最终 `messages[]`
交给对应的 complete 调用。这正是 fairy 那份预设 `prompts[] + prompt_order[]` 机制的最小化对应版。

### 2.1 可用 marker（这是底座与世界的契约，需在 loader 校验白名单）

「展开去向」列（D2 引入）区分该 marker 展开进 **system**（拼进 systemPrompt 字段）还是 **message**（按位置进 messages[]）——这是装配器分流的依据，作者也据此理解「为什么某个 marker 放哪都一样」。

**GM 模板** marker：

| marker | 展开去向 | 展开为 | 来源 |
|---|---|---|---|
| `chat_history` | message | pi 管理的真实对话历史（经 `filterGmContextMessages` 过滤后的 `event.messages`） | `context` 事件 |
| `hook_prompts` | message | 当前激活的 hook 注入提示（现在 `context` 钩子追加的那部分） | `activeHookPrompts()` |

**Writer 模板** marker：

| marker | 展开去向 | 展开为 | 来源（现 `writer-*.ts`） |
|---|---|---|---|
| `writer_base` | **system** | 全局 `.pi/agents/writer.md` 正文（**输出契约所在**，D2） | 现 `buildWriterSystemPrompt` 读的 base skeleton |
| `writing_guides` | **system** | 写作指导目录（kind+description，非正文） | 现 `buildWriterSystemPrompt` 的 catalogue 段 |
| `prior_prose` | message | 历史正文（assistant 消息，含预算裁剪） | `buildFullProseMessages` |
| `plot_digest` | message | 「Prior story elements」摘要 | `buildPlotDigest` |
| `story_elements` | message | 当前回合的 direction packet（`formatPacketForWriter`） | `formatPacketForWriter(currentPacket)` |

> **system 去向的 marker（`writer_base` / `writing_guides`）无论摆在 entries 序列哪个位置，最终都被上提拼进 systemPrompt 字段**（顺序按它们在 entries 中的相对先后，D1/§5.1 的「system 上提」约束）——作者不必纠结把它们排在 few-shot 前还是后。message 去向的 marker 与字面 user/assistant entry 才真正按位置进 messages[]。

> marker 集合是**封闭的、loader 按名校验**（与 `HOOK_ANCHORS` 同款做法）——未知 marker 是**命名错误**，
> 不静默跳过。新增 marker 需要新的运行时展开点，故意保持「加 marker 是刻意行为」。

### 2.2 默认回退（关键，必须实现）

- **世界未声明 `prompt_template.writer`** → 退回现 `buildWriterMessages` + `buildWriterSystemPrompt` 的行为，
  等价于内置模板
  `[{marker: writer_base}(system), {marker: writing_guides}(system), {marker: prior_prose}, {marker: plot_digest}, {marker: story_elements}]`。
  （即：默认模板里 `writer_base` 就在最前，所以无模板时 writer.md 照常作 system 基底——D2 让它在有模板时才需显式列出。）
- **世界未声明 `prompt_template.gm`** → 退回现 `resources_discover` 走 `gmPromptPaths` + `context` 追加 hook 提示的行为。

即：**本轴是纯增量，`border-station` 不声明模板则一字节输出不变。** 现有 273 测试必须继续全绿。

## 3. Schema 与类型（`src/world/schema.ts`）

新增类型（放在 `WritingGuideSpec` 附近，风格对齐现有块注释）：

```ts
/** One entry in a prompt template — either a literal message (with a role, the
 *  seam that lets a world forge fake user/assistant turns) or a marker the base
 *  platform expands into real runtime content at assembly time. */
export type PromptTemplateEntry =
  | { kind: "message"; role: "system" | "user" | "assistant"; content: string }   // content 已由 loader 从 path 读入或直接取字面
  | { kind: "marker"; marker: string };                                            // marker 名，loader 已按目标白名单校验

/** A world-declared prompt template for one agent (gm | writer). Absent ⇒ the
 *  base platform's built-in assembly (back-compatible). */
export type PromptTemplateSpec = {
  entries: PromptTemplateEntry[];
};

/** Both agents' optional templates. */
export type PromptTemplates = {
  gm?: PromptTemplateSpec;
  writer?: PromptTemplateSpec;
};
```

在 `LoadedWorld` 增字段：

```ts
  /** Optional per-agent prompt templates (09). Absent members ⇒ built-in assembly. */
  promptTemplates: PromptTemplates;   // 恒存在；未声明的 agent 成员为 undefined
```

> 决策记录：`content`/`path` 在 **loader 阶段就归一化成 `content`**（读文件），
> 下游装配器只见 `content`，不再碰文件系统——与 `gmPromptPaths` 之外的其它轴把「解析路径」收在 loader 一致。
> 唯一区别：gmPromptPaths 是延迟读取，这里为了装配简单选择 loader 即读；若担心启动 IO，可改为存 path 延迟读，
> 但**必须二选一并在注释写清**。推荐 loader 即读（模板文件小、数量少）。

## 4. Loader（`src/world/loader.ts`）

新增 `parsePromptTemplates(manifest.prompt_template, worldRoot)`，在 `loadWorldFromDir` 的返回对象里接上
`promptTemplates: parsePromptTemplates(manifest.prompt_template, worldRoot)`。

**解析顺序依赖（D3）**：`prompt_template` 必须**先于 `parsePromptPaths` 解析**，因为「有无 gm 模板」决定 `prompts.gm` 是否放宽。落地：

```ts
const promptTemplates = parsePromptTemplates(manifest.prompt_template, worldRoot);
// ...返回对象里：
gmPromptPaths: parsePromptPaths(manifest.prompts, worldRoot, { gmTemplatePresent: promptTemplates.gm !== undefined }),
promptTemplates,
```

`parsePromptPaths` 改造：

- 无 gm 模板 → 维持现状：`prompts.gm` 必须是非空 list（现 `loader.ts:170`）。
- 有 gm 模板 → `prompts` / `prompts.gm` 缺省时返回 `[]`（模板负责全部 system）；若作者**仍写了** `prompts.gm`，照常解析（无模板时它经 resources_discover 生效；有模板时按 §5.2「模板接管则 gmPromptPaths 不经 resources_discover 注入」被忽略，此时 `gmPromptPaths` 仍被解析出来只是不注入——可留作日志/将来用）。

要点（照抄 `parseHooks`/`parseWriting` 的严格校验风格，命名 offending field）：

- 缺省（`undefined`/`null`）→ 返回 `{}`（两个成员都 undefined）。
- `prompt_template.gm` / `prompt_template.writer` 各自可选；present 时其 `entries` 必须是非空 list。
- 每个 entry：
  - 有 `marker` → `{kind:"marker", marker}`，且 `marker` 必须属于**该 agent 的 marker 白名单**
    （GM 用 `GM_MARKERS`，writer 用 `WRITER_MARKERS`，两个常量定义在 schema.ts 并 export）。
  - 否则视为 message：`role` 必须 ∈ `system|user|assistant`；`content` 与 `path` **恰好提供一个**
    （都给或都不给都是命名错误）；`path` 经 `resolveRelative` 解析后 `readFileSync` 读入 content。
    - 文件不存在的处理：**与 writing 一致选择「延迟」还是「即时」**。因为这里 loader 即读，
      文件缺失会在 **load 时**报错（可接受，且比 writing 更早暴露问题）；在注释里写明这一差异。
- marker 白名单常量：

```ts
export const GM_MARKERS = ["chat_history", "hook_prompts"] as const;
export const WRITER_MARKERS = ["writer_base", "writing_guides", "prior_prose", "plot_digest", "story_elements"] as const;
// 展开去向常量：装配器据此把 system 去向的 marker 上提。与 WRITER_MARKERS 同处定义，改一处即校验+分流同步。
export const WRITER_SYSTEM_MARKERS = ["writer_base", "writing_guides"] as const;
```

## 5. 运行时接线

### 5.1 Writer（主改造，`src/runtime/writer-client.ts` + `writer-history.ts`）

当前链路：`turn-commit.ts` → `buildWriterMessages(history, packet)` → `writerClient.render(messages)`
→ render 内 `buildWriterSystemPrompt` 拼 system。

改造思路（**D1：`render` 换签名，装配收进 render**）。因为模板要同时掌控 systemPrompt 与 messages 的顺序，
而这需要原始 `history`+`packet`（造好的 `messages[]` 已丢失 packet 与 history 结构），所以：

0. **`render` 签名从 `render(messages: WriterMessage[])` 改为 `render(input: { history, packet })`**。
   模板本身不走 render 入参——它由 `createConfiguredWriterClient` 的 `input.promptTemplate?` 闭包捕获
   （production 由 `two-pass-render/index.ts` 传 `world.promptTemplates.writer`；测试可省，走无模板路径）。
   - 连带改：`turn-commit.ts:46` 从 `render(buildWriterMessages(history, packet))` 改为 `render({ history: history ?? [], packet })`。
   - 连带改：`writer-client.test.ts` 十余处 `render([...])` 全部改成 `render({ history, packet })`（落地顺序第 3 步先建「无模板等价回归」测试锁行为，再动）。

1. 新增装配器 `assembleWriterPrompt(template | undefined, inputs)`，返回
   `{ systemPrompt, messages, revisionInputs: { storyElementsText, priorProse[] } }`：
   - **无模板** → 等价现行为：`systemPrompt = buildWriterSystemPrompt(...)`，`messages = buildWriterMessages(history, packet)`，
     `revisionInputs` 同 §5.1-3 的显式提取。**这条路径的输出必须与改造前逐字节相等**（回归锚点）。
   - **有模板** → 按 entries 顺序展开，按「展开去向」（§2.1）分流：
     - **system 去向**（`writer_base` / `writing_guides` marker，以及 `role:system` 的字面 entry）→ 收集其文本，
       按 entries 中相对顺序拼接成 `systemPrompt` 字段（见下 provider 适配）。
     - **message 去向**（`prior_prose` / `plot_digest` / `story_elements` marker，以及 `role:user|assistant` 字面 entry）
       → 按模板顺序进 `messages[]`。
     - marker 展开复用现有 helper（**export 出来即可**）：`writer_base` = 现 `buildWriterSystemPrompt` 读的 base skeleton
       （抽 `readWriterBase(projectRoot)`）；`writing_guides` = catalogue 段抽成 `buildWritingGuidesCatalogue(guides)`；
       `prior_prose` = `buildFullProseMessages(history)`；`plot_digest` = `buildPlotDigest(history)`；
       `story_elements` = `formatPacketForWriter(packet)`。
2. **provider 适配（重要，被类型逼出）**：`complete` 入参 `{ systemPrompt, messages }`，systemPrompt 是**单独字段**；
   **`PiAiMessage` 联合没有 `system` 角色**（`writer-client.ts:69-95`，已核对）。故 MVP 硬约束：
   - 所有 system 去向文本**按序拼接**成最终 `systemPrompt` 字段；
   - `user`/`assistant` entry 与 message 去向 marker 按模板顺序进 `messages[]`。
   - **不做** system 夹在 user/assistant 中间（fairy 的「system 可穿插」是已知差异，留后续轴）。在装配器注释写明。
3. `revision` 管道（`reviseProse`）**算法不变，入参改显式**：现在它从 messages 反推
   `lastUserContent`/`priorProseFrom`（`writer-client.ts:246-258`），假设「最后一条 user 是 packet、assistant 是历史正文」。
   模板会打乱消息结构使这两个假设失效——所以装配器**直接产出** `revisionInputs.storyElementsText`（= `formatPacketForWriter(packet)`）
   与 `revisionInputs.priorProse[]`（= `buildFullProseMessages(history)` 的 content 列表），render 传给 `reviseProse` 时用它们，
   **删掉 `lastUserContent`/`priorProseFrom` 这两个反推 helper**。这是本轴最容易踩的坑，务必处理。

### 5.2 GM（`extensions/core.ts`）

GM 的消息链归 pi 管，唯一能整体重写的缝是 **`context` 事件**（`core.ts:68-75`，返回 `{messages}`）。

- **无模板** → 完全保持现状（filter + 追加 hook 提示）。
- **有模板** → 在 `context` handler 里按 GM 模板 entries 重建 `messages`：
  - `message` entry → `{role, content}`。**`RuntimeMessage.role` 是 `string`**（`prose-message.ts:4`），类型上塞
    `role:"system"` 不报错——但 **pi 是否接受 `context` 返回里夹 `role:"system"` 无法从类型确认，落地前必须实测**
    （现有 hook 提示就特意用 `role:"user"`，见 `pending-prompts.ts:60` 的注释「a mid-history system message is not
    universally allowed」）。若实测不接受：GM 模板的 `system` entry 也**降级为 user 角色注入**（或上提——但 GM 侧没有
    独立 systemPrompt 字段可上提，system 段本就靠 `gmPromptPaths` 经 resources_discover 走，见下「注意」），
    在 core.ts 注释写明这个降级。
  - `marker: chat_history` → 展开为 `filterGmContextMessages(event.messages)`（现在的过滤结果）。
  - `marker: hook_prompts` → 展开为 `activeHookPrompts().map(hookPromptMessage)`（现在追加的那部分）。
  - 未出现 `chat_history` marker 的模板是合法的（作者可能故意只给 few-shot），但要 `log` 一条 warning
    （历史丢失通常是笔误）。
- **注意**：`resources_discover` 的 `promptPaths: world.gmPromptPaths` 仍然保留作为「无模板默认」的 system 来源；
  有模板时，GM 的 system 段应来自模板里的 `system` message entry，此时 `gmPromptPaths` 与模板的关系需二选一：
  **推荐**——有 GM 模板时，让模板负责全部（包括 system），`gmPromptPaths` 只在无模板时经 resources_discover 生效。
  在 core.ts 注释写清这个「模板接管则 gmPromptPaths 不再经 resources_discover 注入」的取舍。
  （实现上：`resources_discover` 里 `promptPaths: world.promptTemplates.gm ? [] : world.gmPromptPaths`。）

## 6. 示例与文档

- `worlds/_template/world.yaml`：新增一段**默认注释掉**的 `prompt_template` 示例（照 hooks/writing 段的注释风格），
  给出「伪造一轮 user/assistant few-shot + 保留真实历史」的最小样例：

  ```yaml
  # 可选。自定义 prompt 组装：把 prompt 变成带 role 的有序消息链，可伪造 user/assistant 对话。
  # 不声明则用底座默认组装（行为不变）。marker 由底座展开为真实内容。
  # GM 可用 marker: chat_history | hook_prompts
  # writer 可用 marker: writer_base | writing_guides | prior_prose | plot_digest | story_elements
  #   （writer_base = 底座 writer.md 输出契约；它与 writing_guides 是 system 去向，放哪都会被上提到 systemPrompt）
  # 声明了 prompt_template.gm 时，上面的 prompts.gm 可省略（模板负责全部 system）。
  # prompt_template:
  #   writer:
  #     entries:
  #       - { marker: writer_base }                               # 底座输出契约（<content> 包裹等）；漏写则需自带契约
  #       - { role: system, path: ./prompts/writer-persona.md }   # 你的 writer 人格（可选，追加在契约后）
  #       - { role: user, content: "示例：请把下面要素写成正文。" }  # few-shot 提问
  #       - { role: assistant, content: "示例正文……" }             # few-shot 示范
  #       - { marker: writing_guides }
  #       - { marker: prior_prose }
  #       - { marker: plot_digest }
  #       - { marker: story_elements }
  #   gm:
  #     entries:
  #       - { role: system, path: ./prompts/gm-core.md }
  #       - { marker: chat_history }
  #       - { marker: hook_prompts }
  ```

- `skills/development-guide/references/world-pack.md`：新增「Prompt 模板轴」一节，
  列 marker 表、默认回退、system 上提约束、与 gmPromptPaths 的关系。

## 7. 测试（`test/`，对齐现有静态/fake-provider 策略）

- `test/world/loader-prompt-template.test.ts`：
  - 缺省 → `{}`；gm/writer 各自解析；`content`/`path` 二选一校验；未知 marker 报命名错误；
    白名单区分（GM 用 writer 的 marker 应报错，反之亦然，含 `writer_base` 只属 writer）；`path` 读文件归一化成 content。
  - **D3**：无 gm 模板时 `prompts.gm` 缺省仍报错；有 gm 模板时 `prompts.gm` 缺省 → `gmPromptPaths=[]` 且不报错。
- `test/runtime/writer-prompt-assembly.test.ts`：
  - 无模板 → 装配结果与现 `buildWriterMessages`+`buildWriterSystemPrompt` **逐条相等**（回归锚点）。
  - 有模板 → system 去向（`writer_base`/`writing_guides`/`role:system`）上提拼接、user/assistant 保序、各 marker 正确展开、
    `revisionInputs.storyElementsText`/`priorProse` 正确返回给 revision。
- **`test/runtime/writer-client.test.ts`（D1 连带改，务必）**：十余处 `render([...])` 改成 `render({ history, packet })`。
  这是本轴改动量最大的既有测试面——落地顺序第 3 步「无模板等价回归」通过后再统一改签名，避免边改实现边改断言。
- `test/world/prompt-template-template-world.test.ts`（可选）：`_template` 若启用示例能被 loader 解析。
- GM 侧：在 `extensions` 层若有集成测试位则加一例「有 gm 模板时 context 返回按模板重建」；
  否则至少对 GM 装配器函数做单测（把展开逻辑抽成可测纯函数，不要塞死在 `pi.on("context")` 闭包里）。
- **全量回归**：`npm run typecheck && npm test` 必须全绿（现有例数不许退化；实测基线见落地时 `npm test` 输出）。

## 8. 不做什么（范围护栏）

- **不内置任何 prompt 内容**：底座只做装配 + marker 展开。所有具体文案在世界包里。
- **不做 SillyTavern 的完整 `prompt_order`/`injection_depth`/`injection_trigger`**：只做「有序 entry + role + marker」。
  条件注入（`when`）、按深度注入等留作后续轴，本轮不碰（与 writing 的 `when` 预留同款处理）。
- **不改 revision 管道的算法**，只把它对消息结构的隐式依赖改成显式入参（5.1 第 3 点）。
- **不动 `agent_end`/两段式边界/hooks/OV**。
- **system 消息穿插**：MVP 只做「system 上提到 systemPrompt 字段」，不追求 system 夹在 user/assistant 中间。

## 9. 落地顺序建议

1. schema 类型 + marker 白名单常量（`GM_MARKERS`/`WRITER_MARKERS`/`WRITER_SYSTEM_MARKERS`，纯类型先编译过）。
2. loader 解析 + 单测（先把「输入契约」钉死；含 D3 的 `prompts.gm` 放宽，注意先解析 `prompt_template` 再解析 `prompts`）。
3. writer 装配器：先抽 export 现有 helper（`readWriterBase`/`buildWritingGuidesCatalogue`/`buildFullProseMessages`/
   `buildPlotDigest`/`formatPacketForWriter`），再写 `assembleWriterPrompt`（返回含 `revisionInputs`），
   **先只加装配器单测「无模板路径逐字节等价」**，此时 render 尚未换签名。
4. **D1 换 render 签名**（`render({history,packet})`）+ 改 `turn-commit.ts` 调用点 + 改 `writer-client.test.ts` 全部 `render(...)`；
   同步删 `lastUserContent`/`priorProseFrom`，revision 改吃 `revisionInputs`。此步跑全量确认无模板回归绿。
5. 有模板路径：装配器 + render 接模板（`two-pass-render/index.ts` 传 `world.promptTemplates.writer`）+ 测试。
6. GM 侧 `context` 装配（抽纯函数）+ resources_discover 二选一（`promptTemplates.gm ? [] : gmPromptPaths`）+ **实测 system 角色是否被 pi 接受** + 测试。
7. `_template` 示例 + world-pack.md 文档。
8. 全量 typecheck + test；更新本文件「完成」状态与 MEMORY.md 索引。

## 10. 关键文件索引（省下一个 agent 的探查）

| 关注点 | 文件:符号 |
|---|---|
| 世界包类型契约 | `src/world/schema.ts`（新增在 `WritingGuideSpec` 附近） |
| manifest 解析 | `src/world/loader.ts:loadWorldFromDir` / 仿 `parseHooks`·`parseWriting` |
| writer 消息构造（现默认） | `src/runtime/writer-history.ts:buildWriterMessages` 及其 helper |
| writer system 拼装（现默认） | `src/runtime/writer-client.ts:buildWriterSystemPrompt`（L319） |
| writer render 循环 / revision 入口 | `src/runtime/writer-client.ts:createConfiguredWriterClient`（L130）/`reviseProse`（L184） |
| revision 对消息结构的隐式依赖（**D1 要删**） | `src/runtime/writer-client.ts:lastUserContent`·`priorProseFrom`（L246-258）→ 改为装配器产 `revisionInputs` |
| render 签名 + 现有测试面（**D1 要改**） | `src/runtime/writer-client.ts:WriterClient.render`（L11-13）/ `test/runtime/writer-client.test.ts` 十余处 `render([...])` |
| writer client 生产接线（传模板处） | `extensions/two-pass-render/index.ts:36`（`createConfiguredWriterClient({...})` 加 `promptTemplate: world.promptTemplates.writer`） |
| writer 被调用点（**D1 改签名**） | `src/runtime/turn-commit.ts:commitTurn`（L46 `render(buildWriterMessages(...))` → `render({history,packet})`） |
| WriterMessage 两份定义（需统一） | `src/runtime/writer-client.ts:6`（含 system）/ `src/runtime/writer-history.ts:6`（无 system） |
| GM system 来源 | `extensions/core.ts:resources_discover`（L54-61，`promptPaths: world.gmPromptPaths`） |
| GM 消息可重写缝 | `extensions/core.ts:pi.on("context")`（L68-75） |
| GM 历史过滤 / hook 提示 | `src/runtime/context-filter.ts:filterGmContextMessages` / `src/hooks/pending-prompts.ts:hookPromptMessage`·`activeHookPrompts` |
| RuntimeMessage 是否支持 system 角色 | `src/runtime/prose-message.ts`（落地前先确认，不支持则扩展联合类型） |
| pi-ai 消息类型（system 字段能力） | `src/runtime/writer-client.ts:PiAiMessage`（L69-95） |
