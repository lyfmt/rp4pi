# World Pack 制作与改造指南

## Core Rule

一个「世界」是一个自包含、可替换的目录（world pack）。过去散落在 GM prompt、
开局初值、state 结构、memory schema、设定文档、工具集里的定义，现在全部收敛到
`worlds/<name>/` 这个目录里。`world.yaml` 是唯一入口，具体领域配置推荐拆到同目录
模块 YAML 中。改造一个世界 = 改这个目录，
**不需要改 `src/` 里的注册代码**。

底座启动时扫描 `worlds/*/world.yaml`：
- `RP_WORLD=<name>` 指定则用它；
- 否则用按字母序的第一个；
- `_` 开头的目录（如 `_template`）永不被自动选择，也不能直接运行 —— 复制成正式名字再用。

## 目录结构

```text
worlds/<name>/
├── world.yaml            # 唯一入口：世界元信息 + 模块引用（必填）
├── state.yaml            # 初始状态 + 自定义 attributes
├── prompts.yaml          # GM prompt 路径列表
├── memory.yaml           # OV memory policy + schema 路径
├── lore.yaml             # 固定世界资料源声明
├── tools.yaml            # 工具集声明
├── systems/              # 存档级领域状态与命令模块（可选）
│   └── *.ts
├── subagents.yaml        # 子代理目录声明
├── hooks.yaml            # 生命周期钩子
├── writing.yaml          # 写作指导目录
├── revision.yaml         # 定稿修订策略
├── prompts/
│   └── gm-*.md           # 这个世界的 GM system prompt（按 manifest 顺序拼接）
├── memory/
│   ├── characters.yaml   # OpenViking memory schema（OV 0.4.x 形状）
│   └── story_events.yaml
├── lore/
│   ├── characters.yaml   # 固定人物、地点、规则等权威资料源
│   ├── locations.yaml
│   └── rules.yaml
├── writing/
│   └── *.md              # 写作指导正文（可选，writer 按需读取，见「Writing」）
└── ...
```

## manifest 字段契约

推荐写法是 `world.yaml` 只保留元信息和模块引用：

```yaml
name: my-world
display_name: 我的世界
description: 一句话简介。

state: ./state.yaml
prompts: ./prompts.yaml
memory: ./memory.yaml
lore: ./lore.yaml
tools: ./tools.yaml
systems:
  - ./systems/progression.ts
subagents: ./subagents.yaml
hooks: ./hooks.yaml
writing: ./writing.yaml
revision: ./revision.yaml
```

兼容旧写法：下面这些字段仍可直接内联在 `world.yaml` 中。新写法中，字段值可以是
相对 world 目录的 YAML 文件路径；loader 会先展开这些模块，再按同一套规则校验。

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `name` | 是 | 目录 slug，建议与目录名一致 |
| `display_name` | 否 | 玩家可见世界名，缺省用 `name` |
| `description` | 否 | 一句话简介 |
| `state` | 是 | `state.yaml` 或内联 mapping；含 `initial` / `attributes` |
| `prompts` | 条件 | `prompts.yaml` 或内联 mapping；含 `gm` prompt 文件路径列表 |
| `prompt_template` | 否 | YAML 文件路径或内联 mapping；自定义 GM / writer 的角色化 prompt 组装 |
| `memory` | 是 | `memory.yaml` 或内联 mapping；含 OV policy / schema 路径 / fallback |
| `lore` | 否 | `lore.yaml` 或内联 mapping；固定世界资料源 |
| `tools` | 否 | `tools.yaml` 或内联 mapping；含 `include` / `extra` |
| `systems` | 否 | System module 路径的直接字符串列表；省略时为空列表 |
| `subagents` | 否 | `subagents.yaml` 或内联 list；本世界声明的子代理 |
| `hooks` | 否 | `hooks.yaml` 或内联 list；生命周期钩子 |
| `writing` | 否 | `writing.yaml` 或内联 list；写作指导目录 |
| `revision` | 否 | `revision.yaml` 或内联 mapping；定稿修订策略 |

所有路径都可以是相对（相对 world 目录）或绝对。loader 会把文件路径统一归一化成绝对路径。
`systems` 是直接路径列表，不会像 `state`、`tools` 等字段一样展开为 YAML module。

## Systems（存档级领域模块）

System module 定义世界私有的存档状态、版本生命周期、命令和投影。`world.yaml` 只声明本地模块路径：

```text
worlds/<name>/
├── world.yaml
└── systems/
    └── my-system.ts
```

```yaml
systems:
  - ./systems/progression.ts
  - ./systems/quest.ts
```

每个文件导出一个或多个 `defineSystem()` 结果。启动时，底座按路径和 export key 顺序收集 definition，随后校验名称、版本、依赖与 capability。缺文件、重复名称、依赖环或未安装 capability 都会阻止启动。

```ts
import { defineSystem } from "../../../src/systems/define-system.ts";

type ProgressionState = {
  level: number;
  xp: number;
  perks: string[];
};

type GainXpInput = {
  amount: number;
};

function parseProgression(payload: unknown): ProgressionState {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("progression payload must be an object");
  }
  const state = payload as Partial<ProgressionState>;
  if (
    typeof state.level !== "number" ||
    !Number.isInteger(state.level) ||
    typeof state.xp !== "number" ||
    !Number.isInteger(state.xp) ||
    !Array.isArray(state.perks) ||
    !state.perks.every((perk) => typeof perk === "string")
  ) {
    throw new Error("invalid progression payload");
  }
  return state as ProgressionState;
}

function parseGainXp(input: unknown): GainXpInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("gain_xp input must be an object");
  }
  const amount = (input as { amount?: unknown }).amount;
  if (!Number.isInteger(amount) || (amount as number) <= 0) {
    throw new Error("gain_xp amount must be a positive integer");
  }
  return { amount: amount as number };
}

export const progressionSystem = defineSystem<ProgressionState>({
  name: "progression",
  version: 1,
  initialize: () => ({ level: 1, xp: 0, perks: [] }),
  parse: parseProgression,
  commands: {
    gain_xp: {
      parseInput: parseGainXp,
      execute(_context, state, input) {
        const { amount } = input as GainXpInput;
        const xp = state.xp + amount;
        return {
          nextState: { ...state, perks: [...state.perks], xp },
          result: { accepted: true, xp }
        };
      }
    }
  },
  project(_context, state) {
    return {
      level: state.level,
      xp: state.xp,
      perkCount: state.perks.length
    };
  }
});
```

边界规则：

- System module 不导出 Pi tool，也不接收 Pi context。
- System module 自有 state schema、version、commands 和 projection；Core 不解释这些字段。
- System module 不访问 SQLite 或 repository；底座按 `(save_id, system_name)` 持久化 opaque JSON payload。
- System module 不 import `src/state/sqlite.ts` 或 Pi types；它只依赖 `defineSystem()` interface。
- System module state 只能通过 `commit_turn` 的 operation 推进；module 不自行注册 Pi tool。
- `initialize()` 和 migration 只在 save activation 阶段执行；单纯启动 runtime 不会初始化存档。

GM 调用真实 operation 形状：

```json
{
  "operations": [
    { "system": "progression", "command": "gain_xp", "input": { "amount": 25 } }
  ]
}
```

Core player/time/scene/attributes 变化仍使用对应的 `update_*` 工具；上述
`commit_turn` 只推进 System state，之后仍须单独调用 `submit_direction_packet`。

## 固定核心 vs 可扩展 attributes

state 分两层：

- **固定核心**（`player` / `time` / `scene`）：所有世界共享，底座保证存在，由专用工具
  `update_player_status` / `update_location` / `update_time` / `update_scene` 维护。**你不需要也不能改它的结构。**
- **可扩展 attributes**：每个世界在 `state.attributes` 里声明自己的属性。运行时由**一个通用工具**
  `update_attribute` 维护 —— 加一个 `sanity` / `karma` / `inventory` 不需要写任何工具代码。

attribute 声明形状：

```yaml
attributes:
  sanity:
    type: int          # int | string | bool
    min: 0             # 仅 int：下界（可选）
    max: 100           # 仅 int：上界（可选）
    initial: 100       # 开局值（必填）
    description: 玩家理智。目睹异常时下降。
```

- `int`：`update_attribute` 会做整数校验 + min/max 边界校验。
- `string` / `bool`：类型校验，模型写成相邻类型（如 "true"）会被归一化。
- 写未声明的属性名会被拒绝，并列出本世界可用属性。
- 老存档（attributes 段出现之前写入的）会安全 hydrate 成空 map，不会报错。

## memory 与 OpenViking 的关系

- **memory 对齐 OpenViking，不做后端抽象**。`memory` 段存的就是「这个世界的 OV 配置」。
- **连接配置（url / apiKey / account）不进世界包**，留在 `.pi/agent/settings.json` ——
  那是部署环境的事，一个 OV 实例可以服务多个世界。世界包只声明「记什么」。
- `memory.policy` 取代了过去硬编码在 `turn-memory-hook.ts` 里的策略常量。
- OV 服务端要真正加载你的 schema，还需在 `~/.openviking/ov.conf` 的
  `memory.custom_templates_dir` 指向你世界包的 `memory/` 目录并重启 OV。
  schema 文件形状与调试见 [openviking.md](./openviking.md)。

## Lore（固定世界资料）

`lore` 是不会随存档改变的世界权威资料：人物设定、地点、背景、等级、丹药、功法、规则等。源文件留在世界包里，启动时导入 SQLite 只读索引；运行中用 `lookup/read_lore` 查询，编辑入口始终是 `worlds/<name>/lore*.yaml`。

```yaml
# lore.yaml
version: 1
sources:
  - path: ./lore/characters.yaml
    default_kind: character
  - path: ./lore/locations.yaml
    default_kind: location
  - path: ./lore/rules.yaml
    default_kind: rule
```

源文件可以是数组，也可以是 `{ entries: [...] }`：

```yaml
- id: character.han-yue
  name: 韩越
  aliases: [受伤信使]
  summary: 携带密信抵达北门驿站的边关信使。
  body: 他失血未止，但仍坚持把密信送到可信之人手中。
  tags: [信使, 密信]
  visibility: public
  fields:
    faction: 边军驿传
  relations:
    - { type: located_at, target: location.border-relay }
```

分工：

| 要查什么 | 工具 |
| --- | --- |
| 固定世界资料 | `lookup` / `read_lore` |
| 当前存档状态 | `get_status` |
| 当前存档旧经历 | `search_memory` / `read_memory` |

`visibility` 第一版支持 `public` / `gm` / `secret`。工具会把它作为资料元数据保存；角色是否应知道某条资料，仍由 GM prompt 与子代理工具白名单共同约束。

## Tools（GM 工具面）

`tools` 由世界包声明，底座负责把声明解析成 GM 可见工具。换世界时，不需要改
`src/tools/registry.ts`。

```yaml
tools:
include:
  - core.state
  - core.memory
  - core.lookup
extra:
  - ./tools/local-tool.ts
```

| 字段 | 含义 |
| --- | --- |
| `include` | 引用底座内置工具组。`core.state` 提供状态与回合提交工具；`core.memory` 在 OV 可用时提供 `search_memory` / `read_memory`；`core.lookup` 提供固定资料 `lookup` / `read_lore`。 |
| `extra` | world-local 工具模块路径，相对 world 目录或绝对路径。模块需导出一个或多个 `ToolDefinition` 对象。 |

`extra` 模块加载时会扫描所有导出，只注册形如 `{ name, description, parameters, execute }`
的工具对象；没有可注册工具或工具重名会在启动时直接报错。

省略整个 `tools` 段时，默认等价于 `include: [core.state, core.memory]`；显式写
`include: []` 才表示不导入底座工具组。

### world-local GM 工具最小示例

`tools.extra` 只注册 **GM 可见工具**。它不会自动给子代理使用；子代理需要自己的工具时，
在 `subagents.yaml` 里用 `tools` 白名单 + `extension` 单独声明（见下一节）。

示例：给世界增加一个 `roll_weather` 工具，让 GM 按需掷出天气倾向。

目录：

```text
worlds/my-world/
├── tools.yaml
└── tools/
    └── roll-weather.ts
```

`tools.yaml`：

```yaml
include:
  - core.state
  - core.memory
extra:
  - ./tools/roll-weather.ts
```

`tools/roll-weather.ts`：

```ts
import type { AgentToolResult, ToolDefinition } from "../../../src/types/pi.ts";

type WeatherResult = AgentToolResult<{
  weather: string;
  intensity: number;
}>;

export const rollWeatherTool: ToolDefinition<WeatherResult> = {
  name: "roll_weather",
  label: "天气",
  description:
    "为当前场景生成一个天气倾向。\n\n" +
    "使用边界：当 GM 需要随机天气或环境压力时调用；结果只是素材，是否写入场景由 GM 裁定。\n" +
    "禁区：不要直接修改状态；若天气已经成为当前场景事实，GM 应再调用 update_scene 落场景摘要。",
  parameters: {
    type: "object",
    properties: {
      mood: {
        type: "string",
        description: "可选。希望偏向的氛围，如 cold / tense / calm。"
      }
    }
  },
  execute(_toolCallId, params) {
    const input = params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
    const mood = typeof input.mood === "string" ? input.mood : "";
    const table = mood === "cold"
      ? ["细雪", "冻雨", "干冷的风"]
      : ["薄雾", "短雨", "阴云", "晴光"];
    const index = Math.floor(Math.random() * table.length);
    const weather = table[index];
    const intensity = index + 1;

    return {
      content: [{ type: "text", text: `天气倾向：${weather}（强度 ${intensity}）。` }],
      details: { weather, intensity }
    };
  }
};
```

注册规则：

- 模块可以导出一个或多个工具对象；底座会扫描所有导出，注册符合
  `{ name, description, parameters, execute }` 形状的对象。
- `name` 是运行时工具名，必须与其它工具不重名；重名会在启动时报错。
- `description` 要写清楚使用边界和禁区，因为 GM 会按它决定何时调用。
- `parameters` 是 JSON Schema 风格对象，用来告诉模型该传什么参数。
- `execute` 使用 Pi 工具签名：`(toolCallId, params, signal, onUpdate, ctx)`；
  不需要的参数可以省略或以下划线命名。
- 返回值必须是 `AgentToolResult` 形状：`content: [{ type: "text", text }]`，
  并带 `details`。普通素材工具不要设置 `terminate: true`；展示收口统一用
  `submit_direction_packet`。此前的 Core 变化走现有 `update_*`，System module
  state 变化走 `commit_turn` operations。
- 如果工具只是提供随机表、规则查询、世界知识查询，放在 `tools.extra` 很合适；
  如果它要改固定状态，优先让 GM 调底座状态工具或声明 hook，不要绕过状态边界。

## Subagents（子代理）

子代理是 GM 可以委派的独立子进程（底座用 `pi-subagents` 运行），跑在自己的工具白名单里（最小权限）。启动时底座把每个声明**物化**成 `.pi/agents/<name>.md`，GM 通过内置 `subagent` 工具按名委派。世界包只声明，不写注册代码。

固定资料工具不会自动注入所有子代理。需要核对世界设定的研究型/导演型子代理，可以在 `tools` 白名单显式写 `lookup, read_lore`；长期扮演型 role 子代理默认不要给 secret lore，避免角色知道不该知道的秘密。

分两类，`kind` 字段区分（缺省 `tool`）：

| | `kind: tool` | `kind: role` |
| --- | --- | --- |
| 定位 | 用完即弃的工具型 | 长期扮演单个角色 |
| 状态 | 无状态，每次全新 | 保留自己的**行动轨迹**，连续扮演 |
| 声明什么 | name/description/tools/prompt/extension | **只写 name/description/prompt**（人设） |
| 工具 | 你声明的白名单 | 底座自动注入 `recall_self` / `remember_action` |
| 范例 | `npc-generator`（生成 NPC 落库） | `wounded-messenger`（扮演受伤信使韩越） |

### 字段

```yaml
subagents:
  - name: my-actor          # 必填。slug，世界内唯一；对 role 而言 name 即“角色标识”
    kind: role              # tool（缺省）| role
    description: 一句话职责  # 必填。GM 据此挑选委派
    prompt: ./subagents/my-actor/agent.md   # 必填。人设文件 → 子进程 system prompt
    # 下面几项按需：
    tools: [ some_tool ]    # 工具白名单（最小权限）；缺省/空 = 无工具。role 无需声明（自动注入）
    extension: ./subagents/my-actor/index.ts # 仅子进程加载的工具注册文件（tool 型常用）
    model: provider/id      # 可选，缺省继承默认模型
    thinking: high          # 可选，思考档位
```

### 用户侧模型覆盖

世界包里的 `model` / `thinking` 是默认值。用户本地可在 `.pi/agent/settings.json`
的 `rpSubagents` 段覆盖某个子代理的模型配置，不需要改世界包：

```json
{
  "defaultProvider": "opencode-go",
  "defaultModel": "deepseek-v4-pro",
  "rpSubagents": {
    "npc-generator": {
      "provider": "opencode-go",
      "model": "deepseek-v4-pro",
      "thinking": "high"
    },
    "wounded-messenger": {
      "model": "opencode-go/deepseek-v4-pro"
    },
    "role-forger": {
      "provider": "opencode-go",
      "model": "deepseek-v4-pro",
      "thinking": "high"
    }
  }
}
```

上面的名字来自 `border-station` 示例；新世界把 key 换成自己在 `subagents.yaml`
里声明的子代理名。

优先级：`.pi/agent/settings.json` > `worlds/<name>/subagents.yaml` > Pi 默认模型。
settings 只覆盖 `model` / `thinking`；`kind`、`prompt`、`tools`、`extension` 仍由世界包声明。
不在当前世界里的名字会被忽略，方便同一份 settings 保留多个世界的本地模型偏好。
`subagents` 段保留给 Pi / pi-subagents 原生设置（如 `disableBuiltins`），RP 子代理模型偏好写在 `rpSubagents`。
GM 游玩中 `forge_role` 生成的动态 role 也按角色名读取同一段配置；已知道某个动态角色名后，可加一条同名覆盖。
writer / revision 管道不是 pi-subagents 子进程：writer 主体读 `writer` 段，增强/critic 可用 `writerAgents` 段单独覆盖。

### role 型：轨迹如何工作

role 子进程每次被唤起都是全新进程，靠两个自动注入的工具维持连续性：

- **`recall_self`**：开口前调，回灌「滚动摘要 + 此后逐条原文」+ 从 OV `characters` 读到的角色背景。
- **`remember_action`**：回合末调，把这一回合的言行逐字追加进轨迹；轨迹过长时角色自己产出一段摘要折叠进去。

轨迹按 **存档 + 角色名** 存进本地库（不进 OV，同步、高保真、可随 `/roll` 回退）。role 只需写好 `agent.md` 人设（第一人称、纪律要求它先 `recall_self` 再开口、收尾 `remember_action`），机制全由底座提供。人设写法照抄 `worlds/border-station/subagents/wounded-messenger/agent.md`。

### GM 游玩中动态生成角色（forge_role）

除了世界包**静态声明**的 role，GM 还能在**游玩中动态生成**新的可扮演角色，让世界人物不断生长。做法：声明一个**工具型**子代理（惯例名 `role-forger`），白名单给底座通用工具 `forge_role`，extension 一行 re-export 即可：

```yaml
  - name: role-forger
    kind: tool
    description: 依据线索铸造一个可长期扮演的新具名角色，登记为 role 并落 characters 记忆。
    tools: [ forge_role ]
    prompt: ./subagents/role-forger/agent.md
    extension: ./subagents/role-forger/index.ts
```

`worlds/<name>/subagents/role-forger/index.ts`：

```ts
export { forgeRoleTool, parseForgeRoleInput, activate, default } from "../../../../src/subagents/forge-role.ts";
```

GM 委派 `role-forger` 并给出角色线索 → 它构造人设并调 `forge_role`：①持久到当前存档（`dynamic_roles` 表）②立即物化成 `.pi/agents/<name>.md`（**当回合起 GM 就能委派扮演**，pi-subagents 每次委派都重扫目录）③落一条 `characters` 记忆。动态角色**归属生成它的存档**，换存档不可见，重开该存档自动恢复。照抄 `worlds/border-station/subagents/role-forger/`。

> 区分：只需「记住有这么个人」用 `npc-generator`（仅落 characters）；需要「这个人能被持续扮演、有连续言行」才用 `role-forger`（登记为 role）。

### 本轮 NPC 编排：role 产出如何流进正文

一个可渲染回合里，GM 的固定编排是：分析场景 → 产出**本轮在场且有戏份**的 NPC 清单（通常 1~3 人）→ **并发委派**各自的 role 子代理扮演 → 收集各子代理返回、**去掉相互矛盾** → 更新状态、推进回合 → 把去矛盾后的各角色行动依据交给 writer。

承载「各角色行动信息」的通道是 direction packet 里 `storyElements.characterActions`——一个 `{name, action}` 列表，`action` 是该角色本轮已裁定成立的台词/心情/下一步。底座把它作为**权威来源**渲染进 writer 输入（`Character actions (authoritative …)`）：writer 据此写角色行为，不会另编与之矛盾的言行，也不会替未列出的角色擅自发言。清单为空（纯独白/环境）时留空，该段整体省略。

> 这条通道让 role 子代理的第一人称产出（`recall_self`→扮演→`remember_action`）真正落到玩家可见正文里，而不是停在 GM 上下文中。GM 引导写法照抄 `worlds/border-station/prompts/gm-tools.md` 的「本轮 NPC 编排」小节。

## Hooks（生命周期钩子）

`hooks` 让世界把**通用逻辑**声明式地挂到运行时生命周期节点上——世界只声明「在哪个锚点、多久一次、做什么」，底座负责锚点接线、按存档持久化的 cadence 记账、以及动作派发。与 subagents 同范式（世界只声明，底座提供机制）。

一条 hook = 锚点 `on` + 可选节流 `every` + 动作 `do`：

```yaml
hooks:
  - name: clock-drift          # 存档内唯一 slug，也是 cadence 记账的键
    description: 每回合推进约一小时。   # 可选，给文档/日志看
    on: turn_committed          # 锚点，见下表
    every: { turns: 4 }         # 可选节流；省略则每次命中锚点都触发
    do:                         # 动作，三选一：inject / state / delegate
      type: state
      mutations:
        - { path: time.hour, op: add, value: 1 }
```

### 锚点（on）

| 锚点 | 何时触发 | 典型用途 |
| --- | --- | --- |
| `session_start` | 每个会话的首回合，仅一次（读档/开新档后 GM 开口前） | 开场氛围、一次性提示 |
| `turn_start` | 每回合 GM agent loop 开始前 | 给**本回合**注入提示/提醒 |
| `turn_committed` | 每回合叙事渲染并提交之后 | 背景推进、时间/属性漂移、派生记账 |

`inject as:prompt` 的注入时机由锚点决定：`session_start`/`turn_start` 进**本回合**上下文，`turn_committed` 进**下一回合**上下文（钩子在回合提交后才跑）。

### 节流（every）

按 **(存档, 钩子)** 持久化「上次触发点」，跨读档存续。三个门相互独立，给多个时取**并集**（任一 elapsed 即触发）：

- `turns: N` —— 距上次触发已提交 ≥N 回合。
- `gameHours: N` / `gameDays: N` —— 按 state 里的游戏内时间（绝对时间线，跨天）算。

省略 `every` 则每次命中锚点都触发。首次遇到（无历史）总是触发一次（bootstrap）。**`/roll` 不回滚 cadence**——否则每次 undo 都会重触发；这是刻意设计。

### 动作（do）三类

- **`inject`** —— 把一行文本送进游戏。`as: prompt`（默认）拼进 GM 上下文，作为 GM 自行编织的导演提示（**不是**玩家发言，建议用 `〔场景提示〕…` 之类前缀标注）；`as: notice` 是玩家可见的样式化提示，空闲时投递，**不触发新回合、不进 GM 上下文**。
  ```yaml
  do: { type: inject, as: notice, text: 晨雾在梁柱间浮动，这一天不会太平。 }
  ```
- **`state`** —— 声明式改 state，无需 GM 介入。`mutations` 是 `{path, op, value}` 列表：`path` 寻址 `attributes.<name>` 或固定核心（`time.hour`/`time.day`/`player.status`/`player.location`/`player.name`/`scene.summary`）；`op: add` 仅限数值（`time.hour` 会进位到天），`op: set` 直接赋值。副作用走底座统一的 state store，和工具写一致；`turn_committed` 的改动落进 latest state、成为**下一回合起点**（不改本回合快照，故与 `/roll` 不冲突）。
  ```yaml
  do: { type: state, mutations: [ { path: attributes.vigor, op: add, value: -1 } ] }
  ```
- **`delegate`** —— 请 GM 委派某个 subagent 产出内容再织入叙事。⚠️ **MVP 限制**：钩子跑在 GM loop 之外、无法自己调 `subagent` 工具，所以 delegate 实现为**注入一条指示**，由 GM 在其回合里实际委派；真正的「钩子自主 spawn」是后续独立大工程。`subagent` 必须是本世界已声明的子代理名。
  ```yaml
  do: { type: delegate, subagent: role-forger, task: 铸造一名恰好路过驿站的旅商。 }
  ```

单个 hook 抛错只记日志跳过，**绝不打断它所在的回合**（回合/剧情提交才是权威，钩子是尽力而为的点缀）。

范例见 `worlds/border-station/world.yaml` 的 `hooks:` 段（session_start 氛围 notice + turn_committed 时钟漂移 + 带 cadence 的背景事件提示）。

## Prompt 模板

`prompt_template` 让世界包接管 GM / writer 的 prompt 组装顺序。它把 prompt 从「一组 system 文本」扩展成有序 entry 列表：字面消息 + 底座 marker。

```yaml
prompt_template:
  writer:
    entries:
      - { marker: writer_base }
      - { role: system, path: ./prompts/writer-persona.md }
      - { role: user, content: "示例：请把下面要素写成正文。" }
      - { role: assistant, content: "示例正文。" }
      - { marker: writing_guides }
      - { marker: prior_prose }
      - { marker: plot_digest }
      - { marker: story_elements }
  gm:
    entries:
      - { role: system, path: ./prompts/gm-core.md }
      - { marker: chat_history }
      - { marker: hook_prompts }
```

### entry 形状

| 形状 | 含义 |
| --- | --- |
| `{ role, content }` | 字面消息，`role` 为 `system` / `user` / `assistant`；也可写缩写 `s` / `u` / `a` |
| `{ role, path }` | 从 world 目录相对路径读取正文后作为字面消息 |
| `{ marker }` | 底座在该位置展开真实运行内容 |

`content` 和 `path` 必须二选一。模板文件在加载世界时读取，路径写错会在启动时暴露。无法识别的 `role` 会按 `user` 处理。

### marker

| agent | marker | 展开 |
| --- | --- | --- |
| GM | `chat_history` | 真实对话历史，过滤掉 writer 渲染正文 |
| GM | `hook_prompts` | 当前激活的 hook 提示 |
| writer | `writer_base` | `.pi/agents/writer.md` 的底座输出契约 |
| writer | `writing_guides` | writing 指导目录（kind + description） |
| writer | `prior_prose` | 历史正文 |
| writer | `plot_digest` | 历史 story elements 摘要 |
| writer | `story_elements` | 当前 direction packet |

marker 是封闭白名单，写错会直接报 loader 错误。

### 默认回退

不声明 `prompt_template.writer` 时，writer 行为等价于：

```yaml
- { marker: writer_base }
- { marker: writing_guides }
- { marker: prior_prose }
- { marker: plot_digest }
- { marker: story_elements }
```

不声明 `prompt_template.gm` 时，GM 仍使用 `prompts.gm` 经 `resources_discover` 注入 system prompt，并在 context 中追加 hook 提示。

声明了 `prompt_template.gm` 时，模板负责完整 GM 上下文，`prompts.gm` 可省略；即使保留也不会通过 `resources_discover` 注入。

### system 处理

writer 的 `system` 字面 entry、`writer_base`、`writing_guides` 会按模板中的相对顺序上提拼成 provider 的 `systemPrompt` 字段；user/assistant entry 和其它 marker 按顺序进入 messages。

GM 的 `context` 接口没有独立 `systemPrompt` 字段，且中途 system 消息不是所有 provider 都接受。为兼容，GM 模板里的 `role: system` 字面 entry 会作为 `role: user` 的指导消息注入。

## Writing（写作指导）

`workflow.md` 的 Step_4「按需读取写作指导」这一轴：世界声明**这个世界该怎么写**（叙事风格、对话指导、成人场景指导等），底座把它接给 writer。与 subagents / hooks 同范式——**世界只声明，底座提供机制**。

### writer 是一个只读 agent（不是被动的正文生成器）

正文由 **Pass B 的 writer** 产出。writer 不再是「单次调用出正文」，而是一个**能自主调只读工具**的多步 agent：它 lookup 记忆 / get_status / read_writing_guide，据此**规划三回合因果链 → 落初稿 → 强制自检修订**，最后只交出玩家可见正文（workflow.md Step_4~7）。

- writer 的工具集**全只读**：`get_status`、`lookup`/`read_lore`、`read_writing_guide`、`search_memory`/`read_memory`（OV 可用时）。它**永不写状态、永不提交回合**——状态只由 GM 侧工具写。
- writer 的中间推理与工具往返**不进玩家正文、不进 GM 上下文**，只有最终 prose 落进回合。
- 迭代有硬上限（`WRITER_MAX_STEPS`）：最后一步强制不给工具，逼它交稿，防无限循环。
- writer 的连接/模型读 `.pi/agent/settings.json` 的 `writer` 段；修订管道里的顾问/critic 可读 `writerAgents` 段覆盖（部署配置，**不进世界包**）。世界包只声明「写什么/怎么写」。

### 字段

```yaml
writing:
  - kind: style              # 分类 slug，世界内唯一；writer 用它作为 read_writing_guide 的 key
    description: 叙事语气、感官细节、篇幅节奏。   # 一句话，列进 writer 的「可用指导目录」
    path: ./writing/style.md # 指导正文文件（相对 world 目录或绝对）
  - kind: dialogue
    description: 有 NPC 开口时的对白质感与格式。
    path: ./writing/dialogue.md
  # - kind: adult
  #   description: 成人场景指导。
  #   path: ./writing/adult.md
  #   when: adult_scene       # 预留：后续条件注入，MVP 暂不评估（见下）
```

- `kind`：分类 slug（字母/数字/`-`/`_`），世界内唯一。
- `description`：一句话摘要，**必填**——它是 writer「可用指导目录」里唯一能看到的东西。
- `path`：指导正文路径。**加载时不校验文件存在**（和 subagents 的 persona 一致）；writer 真去读某类指导时才报清晰的按类读取错误，而非启动即崩。
- `when`：**预留**字段，为后续「条件注入」（如成人指导仅成人场景才可读）留位；MVP 暂不评估，所有声明的 kind 都进目录。

### 全量注入 vs 按需读取（本实现：按需）

writer 的 system prompt **只叠加一份「可用指导目录」**（各 kind + description），**不预注入任何指导正文**。writer 判断某类指导与本回合相关时，自己调 `read_writing_guide` 按 `kind` 拉全文再落笔——这正是 workflow.md 说的「按需读取」，比全量塞进上下文更省、更贴切。

> 与 GM prompt 的分工一致：`.pi/agents/writer.md` 是**底座通用骨架**（三步纪律 + 自检清单 + 只读工具用法），世界的写作指导**叠**在其上；换世界不改 writer.md。

### 无 `writing:` 段的世界

完全向后兼容：没声明 `writing:` 的世界，writer 就退回 `.pi/agents/writer.md` 的通用骨架，不暴露 `read_writing_guide`，行为不退化。

范例见 `worlds/border-station/`：`world.yaml` 的 `writing:` 段 + `writing/style.md`、`writing/dialogue.md`。

## 定稿修订管道

writer 出初稿后**不直接交付**，先过一条底座强制的修订管道，再把结果作为玩家可见正文。这是把 workflow.md Step_7「强制自检修订」从"祈祷模型自觉"变成"代码逼它过审再放行"的机制——writer 单靠自己的 prompt 纪律做不到硬保证。

三个环节，都**只给 writer 建议、由 writer 落最终文本**（writer 始终独占正文著作权）：

1. **文风增强**（条件跑，在最前）——仅当世界声明了 `writing:` 指导时。一个文风顾问 agent 读指导正文，对初稿给出可操作的增强建议；writer 据建议重写。指导已充分贴合则跳过。
2. **惯性审稿**（必跑，LLM critic）——拿此前已发布的正文 + 最新初稿，指出**与前文明显重复**的意象/句式/措辞/套路（语义重复，非字面）。
3. **八股审稿**（必跑，LLM critic）——拿世界声明的 `revision.banned_words` 禁词表，指出初稿**触犯的禁词及其变体/近义套话**。

惯性/八股任一报出问题 → 问题合并回灌 writer → writer 一次性重写 → 两个 critic 再跑一遍。至多 `REVISION_MAX_ROUNDS` 轮（默认 2），到顶返回最后一版重写——**永不因 critic 不满意而卡住回合**。

### 字段

```yaml
revision:
  banned_words:        # 八股 critic 的禁词表；缺省为空(critic 仍跑，只是无世界特定禁词)
    - 忽然
    - 顿时
    - 仿佛时间静止
```

- `banned_words`：字符串列表，八股 critic 的**权威禁词/套话表**。critic 是 LLM，会连变体和近义八股一起挑，不只字面命中。
- **禁词表 = 世界声明；文风增强的依据 = 复用 `writing:` 指导**——不另设来源。惯性审稿无需配置（历史正文运行时已有）。
- 三个 agent 的 system prompt 是**底座预设**（`src/runtime/writer-revision.ts`），世界不写它们，只喂配置。

### 模型配置

writer 主体读 `.pi/agent/settings.json` 的 `writer` 段。修订管道可用 `writerAgents`
为三个只读建议/审稿 agent 单独指定模型；未指定时回退 `writer` 模型。最终 rewrite
仍走 `writer` 模型，因为它是玩家可见正文的作者。
`thinking` 是可选字段，运行时会按 Pi 约定拼成 `model:thinking` 交给 model registry。

```json
{
  "writer": {
    "provider": "opencode-go",
    "model": "deepseek-v4-pro",
    "thinking": "high"
  },
  "writerAgents": {
    "styleEnhancer": {
      "provider": "opencode-go",
      "model": "deepseek-v4-pro",
      "thinking": "medium"
    },
    "inertiaCritic": {
      "provider": "opencode-go",
      "model": "deepseek-v4-pro",
      "thinking": "low"
    },
    "clicheCritic": {
      "provider": "opencode-go",
      "model": "deepseek-v4-pro",
      "thinking": "low"
    }
  }
}
```

### 形态与成本

- 修订整段仍在 Pass B（`agent_end`），只改"如何产出 prose"；`commitTurn` 落快照 + emit turn-rendered 的时序不变（OV 沉淀 / hooks 仍订阅**最终** prose）。
- 每回合的模型调用：初稿循环 + （可选增强 + 其重写）+ 每轮 2 个 critic + 命中则 1 次重写。`REVISION_MAX_ROUNDS` 是硬上限。
- 技术形态：writer 在 Pass B（GM loop 外），pi-subagents 无法在此真 spawn 子进程，所以三个"子代理"是循环内**专用 system prompt 的单发 `complete()`**，功能等价，非真子进程（与 writer agent 本身同款约束）。

无 `revision:` 段的世界仍会跑两个 critic（禁词表为空），行为向后兼容。范例见 `worlds/border-station/revision.yaml`。

## 从零做一个新世界

```bash
cp -r worlds/_template worlds/my-world
# 1. 改 worlds/my-world/world.yaml：name、display_name、description
# 2. 改 worlds/my-world/state.yaml：initial、attributes
# 3. 改 worlds/my-world/lore.yaml 与 lore/*.yaml：固定人物、地点、背景、规则
# 4. 改 worlds/my-world/memory.yaml 与 memory/*.yaml：记忆策略和 schema
# 5. 改 worlds/my-world/prompts/gm.md：写你的世界基调、开场钩子、工具纪律
# 6. 跑起来
RP_WORLD=my-world ./start.sh
```

改完后跑校验：

```bash
npm run typecheck
npm test           # loader 会校验你的 manifest 结构；测试全绿说明 manifest 合法
```

## 范例

- **真实范例**：`worlds/border-station/` —— 项目自带的 demo 世界，演示了
  自定义属性 `vigor`、固定 lore、完整 GM prompt 拆分、characters/story_events 记忆。
- **最小范例**：`worlds/_template/` —— 近乎空白、字段带注释的起点，`cp -r` 即用。

## 常见错误与报错

loader 的校验信息会点名出错字段 + 世界名。常见：

- `prompts.gm must be a non-empty list` —— 忘了写 GM prompt 或写成了非列表。
- `memory.schemas must all live in one directory` —— schema 文件分散在多个目录，
  OV 的 `custom_templates_dir` 只能指一个目录。
- `state.initial.time.day must be an integer` —— 初值类型写错。
- `World "<name>" not found` —— `RP_WORLD` 指定了不存在的世界，报错会列出可用世界。
