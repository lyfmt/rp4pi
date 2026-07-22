# 系统扩展契约设计

**状态：** 已批准

**日期：** 2026-07-10

**修订确认：** 2026-07-10，B+C 保持不变；P1 交付 System runtime、生成探针与升级验收，抽卡/RNG 留到 P3；legacy snapshot 使用当前完整状态升级基线。

**前置规格：** `2026-07-10-turn-workflow-and-rollback-boundaries-design.md`

## 目的

在不改变已确认回合边界的前提下，定义核心与可安装游戏系统之间唯一、稳定的 interface。该 interface 必须让 System module 独占自己的状态语义，同时由核心统一保证注册、持久化、事务、工具绑定及 story snapshot/restore。

本规格是 P0 设计交付，不包含 runtime 实现。它以抽卡、生成系统和可升级自定义系统作为探针，验证契约能覆盖独立 schema、多系统原子状态推进、版本迁移及 `/roll`。

## 已确认约束

1. `commit_turn` 是 GM 内部状态推进，不是玩家可见内容提交。
2. 同一次 GM 流程允许多次 `commit_turn`。
3. `commit_turn` 不携带 direction packet、不调用 Writer、不终止 GM。
4. 展示交接不修改确定性状态。
5. Writer 失败时，已经成功完成的状态推进继续有效。
6. 只有成功故事回合创建新的 story snapshot；existing save 的 legacy row 只允许原位升级，不计作新故事回合。
7. `/roll` 恢复故事回合前的核心与全部系统状态。
8. OpenViking 不参与确定性事务。
9. system module 不受核心 entity kind 限制。
10. 归档实现只用于反例和材料，不作为兼容目标。

## 术语

以下项目特有术语已随本规格批准，并同步到 `CONTEXT.md`。

| 术语 | 本规格中的含义 |
| --- | --- |
| System module | 拥有独立状态语义、版本、命令与投影的可安装游戏系统 |
| System state | 由所属 System module 独占解析、校验和修改的 versioned save state |
| State commit | 一次原子状态推进，可包含一个或多个 System module 的 operation，不包含展示交接 |
| Operation | 调用一个 System module command 所需的 system、command 与 input |
| Projection | System module 向调用者公开的只读结果，不暴露原始存储 |
| Capability | 核心或 adapter 按需提供、System module 显式申请的附加能力 |

## 非目标

- 本规格不选择 event sourcing、reducer 或 CRUD 作为所有系统的统一内部模型。
- 本规格不要求所有系统使用 RNG、jobs、audit 或 visibility。
- 本规格不定义 NPC 编排、Writer pipeline 或 OpenViking schema。
- 本规格不实现跨 save 事务或分布式事务。
- 本规格不允许 system module 直接操作其他 system module 的存储。
- 本规格不实现抽卡、生成系统或升级系统；它们只用于验证契约。
- 本规格不把 SQLite transaction、Pi session manager 或 OpenViking client 暴露给 System module。

## 系统探针

### 抽卡探针

抽卡系统以以下 System state 开始一次 GM 流程：

```json
{
  "currency": 10,
  "pity": 9,
  "inventory": []
}
```

它用于验证一个 command 内的多字段原子修改、可选 RNG、结果校验和故事回退。核心不解释 `currency`、`pity` 或 `inventory`。

| 场景 | 预期 |
| --- | --- |
| 成功抽取 | 同一事务扣除 3 currency、推进 pity、记录随机结果、发放物品 |
| 余额不足 | 整个 operation 失败，currency、pity、inventory 全部不变 |
| 物品校验失败 | 已扣资源和 pity 不得部分提交 |
| `/roll` | 恢复抽取前的全部抽卡 System state，包括 currency、pity 与 inventory |

### 生成系统探针

生成系统拥有核心从未见过的 `blueprint` schema，例如：

```json
{
  "blueprints": [
    {
      "id": "relay-alpha",
      "parts": ["core", "antenna"],
      "stability": 0.82
    }
  ]
}
```

它用于验证 System module 可以拥有任意结构、只公开 projection，并与其他系统参与同一个 State commit。核心只保存和恢复该状态，不增加 `blueprint` entity kind，也不解析其中字段。

| 场景 | 预期 |
| --- | --- |
| 创建自有结构 | 系统创建核心从未见过的 `blueprint` 结构，不修改核心 schema |
| 读取投影 | GM 只看到该系统公开的 projection，不读取原始存储 |
| 非法生成结果 | 系统自己的 validation 校验失败并拒绝写入，原状态不变 |
| 与另一系统同一状态推进 | 两个系统要么一起成功，要么一起失败；后一个 operation 失败时前一个不提交 |
| `/roll` | 恢复目标故事回合前的完整 `blueprints` System state，projection 随恢复后的状态重新计算 |

### 可升级自定义系统探针

同一个 System module 的已有存档可能使用 v1，而当前注册版本为 v2：

```text
v1: { level: 2, xp: 50 }
v2: { level: 2, xp: 50, perks: [] }
```

它用于验证 System module 拥有版本识别、迁移和 parser；核心只调度版本流程并提供原子持久化。未知未来版本不得由当前 parser 猜测读取。

| 场景 | 预期 |
| --- | --- |
| 旧存档载入 | 系统识别 v1，并在受控事务中迁移到 v2 |
| migration 失败 | 原始 v1 状态保持可恢复，不留下半迁移数据 |
| 未知未来版本 | 明确失败，不用当前 parser 猜测读取 |
| 新 save | 直接以当前版本初始化 |
| `/roll` | 恢复目标 story snapshot 中该系统的完整 versioned state；若恢复版本需要迁移，仍执行同一受控迁移流程，失败时不留下半恢复状态 |

## 依赖分类

| 依赖 | 分类 | 对 interface 的约束 |
| --- | --- | --- |
| System module 定义、command handler、validation、migration、projection | In-process | 与 runtime 同进程执行；核心可以直接调用，不需要公开 port |
| SQLite | Local-substitutable | P1 使用临时 SQLite 测试完整 runtime interface；事务与表结构留在 implementation 内，不向调用者或 System module 暴露存储 port |
| 世界包与本地 System module 加载 | Local-substitutable | loader 在启动阶段解析模块路径并完成注册；文件系统错误是启动错误，不推迟到 command 执行阶段 |
| Pi tool binding | In-process adapter | adapter 从 Pi context 解析当前 session/save，再调用 runtime；System module 不接触 Pi session manager，测试可直接穿过 runtime interface |
| OpenViking | True external | 继续通过成功故事回合后的订阅链路异步处理，不进入 State commit，也不影响确定性事务结果 |
| RNG、jobs、audit、visibility | Optional capability | 只有被 System module 显式申请且有真实变化点时才提供；缺失在注册或启动阶段失败，不为假设需求预建公开 port |

以下 3 套方案只比较状态推进的外部 interface。它们都必须保留共同底线：System module 拥有自己的 parser、validation、migration、command 与 projection；核心拥有注册、save 定位、事务、versioned payload 持久化和 story snapshot/restore；读取只能经过 module projection。

## 候选 interface

### 方案 A：最小事务上下文

调用者只学习一个状态推进入口。`TurnScope` 只在 callback 内有效，按调用顺序执行 System command：

```ts
await runtime.commit((turn) => {
  const gacha = turn.system("gacha");
  gacha.execute("draw", { banner: "standard", count: 1 });

  const quest = turn.system("quest");
  quest.execute("record_draw", { banner: "standard" });
});
```

| 主题 | 语义 |
| --- | --- |
| Transaction callback 隐藏内容 | 当前 save 定位、namespace 载入、SQLite `BEGIN`/`COMMIT`/`ROLLBACK`、版本检查、handler 路由、最终 validation、持久化及内存态刷新 |
| System lookup | `turn.system(name)` 只查本次启动已注册且 ready 的 module；失败抛出可判断的 `SystemNotRegistered` 或 `SystemNotReady`，不返回 `undefined` |
| 顺序与原子性 | `execute()` 按调用顺序同步执行。callback、lookup、command、validation 中任一异常都回滚本次 callback 内全部 System operation |
| Callback 限制 | callback 必须同步；返回 Promise 或在 handler 内等待远程 I/O 属于 interface 违约。外层 `commit()` 可以返回 Promise 以适配 Pi tool，但 SQLite transaction 内不跨 `await` |
| State ownership | 调用者只拿到没有 `state` 字段的 scoped command handle。runtime 只把所属 namespace 的私有 draft 交给对应 module handler；handler 不能取得其他 module 的可写 state |
| 跨系统读取 | handler 可以通过本次 transaction 的只读 projection view 读取先前 operation 已产生的结果，不能取得或修改其他 namespace 的原始 payload |
| SQLite 隐藏原因 | 暴露 transaction 会泄漏表结构、允许绕过 namespace/validation，并迫使测试越过 runtime interface；SQLite 因此只属于 implementation |
| Tool binding | Pi adapter 必须先把 JSON tool input 翻译成 callback 内的一串 `system().execute()`；这会形成第二套调用描述，需要额外保持语义一致 |
| Migration、snapshot、capability | migration 在 module 进入 ready 前由核心调度；snapshot 由核心枚举 namespace；capability 只进入私有 handler context，不出现在 `TurnScope` |

该方案的主要优势是过程式编排能力：后一个 command 可以由前一个结果决定。主要代价是 LLM 无法提交 callback，Pi `commit_turn` 仍需要另设计一层可序列化协议。

### 方案 B：声明式 operation batch

调用者提交一个只含 operation envelope 的 JSON-compatible batch：

```ts
await runtime.commit({
  operations: [
    { system: "gacha", command: "draw", input: { banner: "standard", count: 1 } },
    { system: "quest", command: "record_draw", input: { banner: "standard" } }
  ]
});
```

| 主题 | 语义 |
| --- | --- |
| Operation 验证 | 核心只校验 batch 及 `{ system, command, input }` envelope；注册表解析 system 和 command，具体 `input` 由所属 module 的 command parser/handler 校验 |
| 顺序与原子性 | operations 按数组顺序执行并共享一个 State commit。任一 operation 失败，整个 batch 回滚；错误携带 `index`、`system`、`command` 与 module cause |
| State ownership | 核心把对应 namespace 的私有 draft 交给 handler，不理解 payload。handler 只能写自己的 draft；后续 handler 只能通过 transaction projection view 读取其他系统 |
| 类型安全 | 动态世界包与 LLM 边界天然是 `unknown`，依赖运行时 parser。静态 TypeScript 调用者可以使用 module 提供的 operation builder，但核心不维护包含所有 command 的联合类型 |
| Tool binding | Pi `commit_turn` 的参数可以直接复用 batch schema；adapter 只解析 session/save、调用 `runtime.commit()` 并把 receipt 转为 tool result，不传递 Pi context |
| 中央 parser 风险 | envelope parser 只认识 3 个通用字段；核心不得增加 command-specific 分支，也不持久化或回放 operation。否则会重新形成已拒绝的中央 `DomainEvent` parser |
| 结果依赖 | input 在执行前已经声明，不能用任意过程代码生成后续 operation；但后续 handler 可读取同一 transaction 中更新后的 projection，覆盖“抽卡后记录任务”等探针 |
| Migration、snapshot、capability | module 注册信息提供 version/migration/capability 要求；核心在 ready、commit 与 snapshot/restore 阶段统一调度，不把这些事实复制进每个 operation |

该方案的主要优势是 runtime interface 与 Pi tool schema 可以保持同形，同时仍把 command 语义留在 System module。主要代价是动态边界没有完整编译期类型，并且必须严守“envelope 不是领域事件”的限制。

### 方案 C：system-owned command dispatch

System module 通过 `defineSystem()` 同时声明生命周期和 command；核心把定义视为 opaque handler 集合：

```ts
const gachaSystem = defineSystem({
  name: "gacha",
  version: 2,
  initialize: () => ({ currency: 0, pity: 0, inventory: [] }),
  parse: parseGachaState,
  migrate: migrateGachaState,
  commands: {
    draw: executeDraw
  },
  project: projectGachaStatus
});
```

`defineSystem()` 返回 module-owned command builder。调用者先构造带有 module identity 的 command，再交给核心 dispatcher：

```ts
await runtime.dispatch([
  gachaSystem.command("draw", { banner: "standard", count: 1 }),
  questSystem.command("record_draw", { banner: "standard" })
]);
```

| 主题 | 语义 |
| --- | --- |
| 核心已知元数据 | `name`、`version`、依赖、所需 capability、command key 及生命周期函数；state schema、command input/output 和 projection schema 对核心保持 opaque |
| Handler 受限能力 | handler 获得自己已解析的 state draft、已解析 input、同一 transaction 的只读 projection view，以及注册时获批的 capability；不获得 SQLite、其他 namespace 或 Pi context |
| Validation 与 migration | `initialize` 的结果、已有 state、command input、command 后 state 均由 module 自己校验；module 实现逐版本 migration，核心只比较版本并提供受控事务 |
| 多系统编排 | 核心 `dispatch()` 接收多个 module-owned command 并保证原子性；若各 module 直接绑定自己的 Pi tool，则跨系统调用仍需额外 aggregator，不能由两个独立 tool call 自动组成同一事务 |
| 类型安全与动态加载 | 静态 TypeScript 调用者可从 module builder 获得较强类型；运行时加载的世界包和 LLM 无法携带这些类型，仍需 module-specific parser 或 tool adapter |
| 错误 | module 返回自己的 parse/validation/command error；dispatcher 包装 system identity 和 command key。注册冲突、未来版本、migration/capability 失败由核心在 ready 前报告 |
| Snapshot/roll | 核心仍按注册表枚举 namespace 并保存 versioned opaque payload；module-owned dispatcher 本身不解决 snapshot，因此必须依赖核心生命周期协调器 |

该方案把 command 定义、类型和变化最大程度集中在 System module，locality 最强。主要代价是 module-owned facade 无法直接成为统一 Pi `commit_turn` 的 JSON schema；若每个 module 自行绑定工具，工具面和跨系统事务会重新分散。

## 方案比较

| 维度 | 方案 A：最小事务上下文 | 方案 B：声明式 operation batch | 方案 C：system-owned command dispatch |
| --- | --- | --- | --- |
| Interface depth | 1 个 `commit(callback)` 获得过程式编排和事务；调用者还需学习 scoped handle、同步 callback 与异常规则 | 1 个 `commit(batch)` 覆盖单/多系统状态推进，调用者只学习 operation envelope、顺序和错误索引 | `defineSystem` + module command builder + `dispatch` 能力强，但世界作者与调用者接触的概念最多 |
| Locality | 事务复杂度集中在 runtime；Pi JSON 到 callback 的翻译集中在 adapter，但形成额外协议 | 新系统的 schema、handler、migration、projection 集中在 module；核心 envelope 和 Pi adapter 通常不变 | 单系统变化最集中；跨系统编排和 module-specific tool wiring 容易散落到调用者 |
| Seam placement | 核心与调用者的 seam 位于 transaction callback/`TurnScope` | seam 位于 JSON-compatible batch envelope；核心与 module 的内部 seam 位于注册 handler | 外部 seam 位于 module facade，核心 seam 位于 opaque command dispatcher |
| State ownership | module handler 独占 state；scoped handle 阻止调用者直接访问 | module handler 独占 state；operation 只描述意图，不携带 state | module 定义最明确地拥有 parse、validation、migration 和 command |
| Multi-system atomicity | 一个 callback 内按执行顺序一起提交或回滚，支持过程式分支 | 一个 operations 数组内按顺序一起提交或回滚；后续 handler 可读更新后的 projection | 多个 command 交给同一次 `dispatch` 时可原子；独立 module tool 不天然原子 |
| Migration | 注册生命周期仍需单独定义；callback 本身不提供迁移优势 | 注册生命周期统一调度，operation 不关心版本 | `defineSystem` 明确把迁移放在 module，表达力最好，但仍依赖核心事务调度 |
| Tool binding | Pi adapter 必须维护一套可序列化输入，再生成 callback 调用 | tool input 与 runtime batch 同形；adapter 最薄 | 静态 builder 不能穿过 LLM JSON 边界，需要 module-specific adapter 或额外通用 envelope |
| Snapshot/roll | 核心可枚举 callback runtime 的注册表并处理 opaque payload | 核心可从同一注册表捕获/恢复全部 versioned payload | 同样依赖核心注册表；module facade 不减少 snapshot 协调复杂度 |
| Error model | lookup/handler/callback error 通过异常回滚；任意 callback 异常扩大了错误来源 | outer parse、operation index、module cause 分层明确，最适合序列化给 GM tool | module error 类型最精确；汇总多个 module error 需要 dispatcher 统一包装 |
| Optional capabilities | 私有 handler context 按注册结果注入，`TurnScope` 不暴露 | 私有 handler context 按 operation 所属 module 注入，batch schema 不膨胀 | module 在定义处声明需求，locality 好；dispatcher 仍需统一核验与注入 |

### 探针适配

| 探针 | 方案 A | 方案 B | 方案 C |
| --- | --- | --- | --- |
| 抽卡 | 强：一个 `execute("draw")` 封装扣费、RNG、pity 与发放，异常整体回滚 | 强：一个 operation 直接对应抽卡 command，input/result 易进入 GM tool | 强：类型、validation 与 RNG 需求集中在 `gachaSystem`；单系统 dispatch 自然 |
| 生成系统 | 强：scoped handle 不暴露未知 `blueprint` state，只返回 projection | 强：核心只路由 envelope，`blueprint` parser 完全属于 module | 强：任意 schema 和 projection 都留在 module definition |
| 可升级系统 | 可满足：迁移依赖 callback 之外的注册生命周期 | 可满足：注册生命周期处理 v1/v2，batch 始终只面向 ready module | 强：`version`、`parse`、`migrate` 在定义处相邻；但核心仍必须提供原子迁移 |
| 多系统失败与 `/roll` | 强：同一 callback 回滚，核心 snapshot 注册表 | 强：同一 batch 回滚，核心 snapshot 注册表；最容易从 tool input 重放验收场景 | 中：统一 dispatch 时可满足；module-specific tool 需要额外 aggregator 才能保证同一事务 |

### 执行者推荐

推荐采用**方案 B 作为调用者与 Pi tool 的状态推进 interface，并吸收方案 C 的 `defineSystem()` 注册模型**：

- 外部只有 JSON-compatible `runtime.commit({ operations })`，Pi `commit_turn` 不需要另一套协议。
- 核心只理解 operation envelope、注册元数据和 versioned opaque payload；每个 module 仍拥有 parser、validation、migration、command 与 projection。
- 多系统原子性、错误索引和 tool result 都能在同一个入口表达；3 个探针无需特殊分支。
- 不保留方案 C 的 `runtime.dispatch(module.command(...))` 作为第二个公开写入口；静态 module 可以提供 builder，但 builder 最终只产生标准 operation。

方案 A 的主要风险不是事务能力，而是 Pi/LLM 不能调用 callback，最终必须再维护一套 batch-to-callback adapter。方案 C 单独采用时的主要风险是工具注册和跨系统事务分散。组合方案的主要风险是方案 B 演变成中央 `DomainEvent` parser；约束方式是核心永远不解析 command-specific input、不持久化 operation，也不把全部 command 收敛成联合类型。

## 最终选择

**状态：** B+C interface 与完整规格均已批准。

**用户确认：** 2026-07-10，选择 B+C 组合。

最终方向采用两层互补 interface：

1. **调用者 interface 采用方案 B。** 状态推进只通过 JSON-compatible `runtime.commit({ operations })`。operations 按声明顺序执行，共享一个 State commit，并返回可序列化 receipt。
2. **System module 作者 interface 吸收方案 C。** `defineSystem()` 把名称、版本、依赖、capability、初始化、解析、迁移、command 和 projection 集中在所属 module。
3. **不保留第二个写入口。** `runtime.dispatch(module.command(...))` 不进入核心公开 interface。静态 TypeScript builder 如有需要，只能生成标准 operation，不能绕过 `commit()`。

最终调用形态为：

```ts
const gachaSystem = defineSystem({
  name: "gacha",
  version: 2,
  initialize: initializeGacha,
  parse: parseGachaState,
  migrate: migrateGachaState,
  commands: { draw: executeDraw },
  project: projectGachaStatus
});

await runtime.commit({
  operations: [
    { system: "gacha", command: "draw", input: { banner: "standard", count: 1 } },
    { system: "quest", command: "record_draw", input: { banner: "standard" } }
  ]
});
```

| 判断维度 | 选择影响 |
| --- | --- |
| Depth | GM、Pi adapter 和集成测试只学习 operation batch、顺序、原子性与错误模型；注册、迁移、存储和 snapshot 留在 implementation 内 |
| Locality | 新增或修改系统时，schema、validation、migration、command 与 projection 都集中在该 System module；核心不增加 command-specific 分支 |
| Seam placement | 调用者与核心的 seam 是 batch；核心与 System module 的 seam 是 `SystemDefinition`；Pi 只在进程内把 session/save 绑定到 batch 调用 |

方案 A 在主要调用者变为可信 TypeScript 代码，且确实需要由前一 command result 动态构造后一 command 时可以重新考虑。方案 C 的独立 dispatcher 只有在每个系统完全独立、无需统一 Pi `commit_turn` 和跨系统原子性时才值得重新考虑。两者当前都不满足本项目以 LLM tool 为主要入口、同时要求多系统原子提交的约束。

## 核心职责

核心运行时对调用者只提供 2 个主要入口：`commit()` 推进状态，`project()` 读取投影。`register()` 属于启动阶段的装配动作，不是 GM 的运行时入口。

```ts
type SystemOperation = {
  system: string;
  command: string;
  input: unknown;
};

type StateCommitRequest = {
  requestId: string;
  expectedRevision?: number;
  operations: readonly [SystemOperation, ...SystemOperation[]];
};

type StateCommitReceipt = {
  commitId: string;
  revision: number;
  branchEpoch: number;
  operations: Array<{
    system: string;
    command: string;
    result: unknown;
  }>;
};

type ProjectionAudience =
  | { kind: "gm" }
  | { kind: "writer" }
  | { kind: "player" }
  | { kind: "system"; name: string };

type ProjectionRequest = {
  audience: ProjectionAudience;
  systems?: readonly string[];
};

type SystemProjection = {
  system: string;
  revision: number;
  value: unknown;
};

interface SystemRuntime {
  commit(request: StateCommitRequest): Promise<StateCommitReceipt>;
  project(request: ProjectionRequest): Promise<SystemProjection[]>;
}
```

`requestId`、当前 `saveId` 与可信 caller identity 由 adapter 注入，不由 LLM 自报。Pi adapter 使用当前 `sessionId` 与 `toolCallId` 的稳定摘要作为 `requestId`；runtime 再按当前 `branchEpoch` 隔离 receipt。`commitId` 在首次成功提交时生成一次并随 receipt 持久化，重放必须返回同一个值。`commit()` receipt 只包含 command 的公开 result、新 revision 与 branch epoch，不返回任何 System state。

| 主题 | 核心 | System module |
| --- | --- | --- |
| 注册 | 校验名称唯一性、版本、依赖图和 capability 可用性；冻结注册表 | 声明名称、版本、依赖、所需 capability 和生命周期函数 |
| 初始化 | 为新 save 或新安装 namespace 调度初始化，并在 setup transaction 中持久化 | 产生当前版本初始 payload，并用自己的 parser 校验 |
| 持久化 | 拥有 namespace、transaction、save revision、branch epoch、idempotency、snapshot/restore | 不接触 SQLite，不决定表结构或提交时机 |
| 解析 | 存储 opaque payload 和 version；只按生命周期调用 module parser | 解析并校验自己的 state，拒绝未知或非法结构 |
| 迁移 | 比较版本、按顺序调用 migration，并提供独立受控事务 | 实现逐版本、确定性的 migration 和迁移后校验 |
| 命令 | 校验 envelope、按顺序路由并保证整个 batch 原子提交 | 校验 input，实现 command 语义并返回 next state 与公开 result |
| 投影 | 聚合已注册系统的 projection，并传入可信 audience | 决定公开 projection，不泄漏原始 payload |
| 工具 | 从 Pi context 解析 session/save/requestId，绑定 `commit_turn` 与读取工具 | 不接触 Pi session context，不自行结束 GM 流程 |

核心不解释任何 command-specific input、System state 字段或 projection 字段。若删除核心 runtime，这些事务、版本、namespace、工具绑定和 snapshot 规则会重新散落到各调用者；这正是该 module 必须隐藏的复杂度。

## System module 职责

`defineSystem()` 是 System module 作者的唯一主要入口。推荐的概念形态如下；P1 可以调整 TypeScript 泛型细节，但不能改变职责分配：

```ts
type SystemCommandContext = {
  read(system: string): unknown;
  capability(name: string): unknown;
};

type ProjectionContext = {
  audience: ProjectionAudience;
};

type SystemDefinition<State> = {
  name: string;
  version: number;
  dependsOn?: readonly string[];
  capabilities?: readonly string[];
  initialize(): unknown;
  parse(payload: unknown): State;
  migrate?(fromVersion: number, payload: unknown): {
    version: number;
    payload: unknown;
  };
  commands: Record<string, {
    parseInput(input: unknown): unknown;
    execute(context: SystemCommandContext, state: Readonly<State>, input: unknown): {
      nextState: unknown;
      result: unknown;
    };
  }>;
  project(context: ProjectionContext, state: Readonly<State>): unknown;
};
```

Module 必须满足以下规则：

- `name` 是稳定 namespace；发布后不能靠改名迁移，改名属于显式卸载/安装流程。
- `initialize()`、`migrate()`、command 和 `project()` 必须是同步、确定性的进程内逻辑，不执行远程 I/O。
- Command handler 只得到自己已解析 state 的只读视图、已解析 input、已声明依赖的 transaction read view，以及获批 capability。
- Handler 返回 `nextState`；核心在持久化前再次调用该 module 的 `parse()`。Module 不取得可写的其他 namespace。
- Command result 和 projection 必须可序列化，但不承担持久化；它们不能成为绕过 namespace 的隐藏写通道。
- 跨系统读取只能读取已声明依赖的 projection。未声明依赖、循环依赖或读取原始 payload 均在注册或调用阶段失败。

## 注册与生命周期

```text
register
-> validate dependencies
-> new save: initialize current version
   existing save: inspect version -> migrate if needed -> parse
-> ready
-> execute commands inside transaction
-> project read model
-> capture/restore story snapshot
```

| 阶段 | 输入 | 成功输出 | 允许失败 | 失败后的持久化状态 |
| --- | --- | --- | --- | --- |
| Register | 世界包解析出的 `SystemDefinition[]` 与 capability catalogue | 冻结、按依赖排序的 registry | 非法名称/版本、重名、非法/空 command key、定义形状非法 | 不写 save；runtime 不启动 |
| Validate dependencies | `dependsOn`、capability 请求和当前 adapter | 依赖图与 capability binding | 缺失 module、循环依赖、capability 不可用 | 不写 save；所有 module 都不进入 ready |
| New save initialize | 当前 registry 与新 save | 每个 namespace 的当前 versioned payload | initialize 抛错、parser 拒绝、结果不可序列化 | setup transaction 整体回滚，不留下部分 System state |
| Existing save inspect | save 中的 namespace、versioned opaque payload 与当前 registry | 待解析或待迁移的完整集合 | snapshot/save 中有未注册 module、payload 缺失、未来版本 | 不写任何 namespace，save 保持原样 |
| Install missing namespace | registry 中存在、save 中尚不存在的 module | 当前版本初始化 state | initialize 或 parser 失败 | 与本次 activation 中其他 setup 变更一起回滚 |
| Migrate | 旧 version/payload 与 module 的逐版本 migration | 当前版本且通过 parser 的 payload | 缺失 migration step、migration 抛错、版本未前进、迁移后校验失败 | 全部 module migration 原子回滚，原始旧 payload 可恢复 |
| Parse current state | 当前 version/payload | runtime 私有的 typed state | parser 拒绝或 payload 不可读取 | 不写持久化；module 不进入 ready |
| Ready | 全部 module 已解析，依赖和 capability 已绑定 | 可接受 `commit()` 和 `project()` 的 runtime | registry 在运行中被修改 | 拒绝热修改；已持久化 state 不变 |
| Execute commands | 非空 operation batch、当前 save/revision | `StateCommitReceipt` 与新 revision | envelope/input/command/state 校验失败、冲突、handler 抛错 | 整个 State commit 回滚，所有参与 namespace 和 revision 不变 |
| Project | ready state 与可信 audience | module-owned read model | module 未 ready、projection 失败、visibility 拒绝 | 只读，不写持久化 |
| Capture snapshot | 成功故事交付后的核心及全部确定性参与者 | 新的 story snapshot | namespace 不完整、序列化或 SQLite 失败 | 当前 state 不回滚；不发布 `turn-rendered` 成功事件 |
| Restore snapshot | 目标 snapshot、当前 registry 与 rerun 输入 | 原子恢复后的确定性 state | module 缺失、未来版本、migration/parse 失败 | 预检或 restore transaction 整体失败，当前 state 与 active snapshot chain 不变 |

Migration 只发生在 activation 或 snapshot restore 的显式生命周期阶段。它不与普通 command batch 隐式混跑。Registry 在 runtime ready 后不可热替换；世界配置变化需要重新 activation。

## 状态 namespace 与版本

- System state 的逻辑主键是 `(saveId, systemName)`。一个 command 只能产生所属 `systemName` 的 `nextState`。
- 每条 System state 同时保存正整数 `version` 和 JSON-compatible opaque payload。核心可以复制、比较版本和原子替换 payload，但不得解释字段。
- Version 只属于单个 System module，不与核心 schema version 或其他 module version 共用计数器。
- `parse()` 是当前版本 state 的唯一解释入口。持久化前、载入后、迁移后和 restore 后都必须通过它。
- 已有 payload 的 version 高于当前 definition 时返回 `SYSTEM_VERSION_FUTURE`；不得用当前 parser 猜测读取。
- 已有 payload 的 version 低于当前 definition 时逐步迁移，每一步必须把 version 向前推进，最终到达当前版本并通过 parser。
- Save 载入时，持久化 namespace 对应的 definition 缺失会失败，绝不静默丢弃。Registry 新增但 save 尚无 state 的 namespace 可以在 activation setup transaction 中初始化。
- Namespace 重命名、显式卸载和跨 save 状态移动不在本规格内；P1 不提供这些入口。

## 事务与错误语义

### 事务不变量

- 同一个 State commit 中的全部 System operations 原子提交。
- Operations 按 batch 顺序执行；后一个 handler 的 transaction read view 能看到前一个 operation 的已验证候选 projection。
- 一个 System command 只能写自己的 namespace。
- 跨系统读取必须通过同一 transaction 的只读 view，而且只能读取已声明依赖的 projection。
- Envelope 与全部 command input 在持久化前完成解析；每个 `nextState` 在进入下一个 operation 前完成 validation。
- Command、input parser、state parser 或 projection 抛错时，不写入任何参与系统。
- Migration 不与普通 command 隐式混跑。
- Handler 在 SQLite transaction 内同步执行，不跨 `await`，不调用 Writer、OpenViking 或其他远程依赖。
- Commit 成功时，System payload、capability-owned deterministic state、save revision、idempotency receipt 和必要 audit 记录在同一 transaction 内落地。

### 顺序、并发与重试

- 每个 save 有单调递增的 `revision` 和只增不减的 `branchEpoch`，初始值均为 0。普通 State commit 只把 revision 加 1；成功 `/roll` restore 在同一事务中把 revision 和 branch epoch 各加 1。
- `expectedRevision` 存在且不匹配时返回 `STATE_COMMIT_CONFLICT`，不自动重放 handler。Restore 后，restore 前读取的 revision 必须失效，不能继续提交旧 draft。
- 未提供 `expectedRevision` 时，runtime 在取得该 save 的写事务后读取最新 revision，并基于最新 state 顺序执行；结果明确为“串行化到最新状态”，不是静默覆盖旧 draft。
- `requestId` 在同一 `(saveId, branchEpoch)` 内唯一。相同 requestId 与相同 canonical batch 再次提交时返回当前分支的原 receipt，不重复 command 或 RNG；相同 requestId 携带不同 batch 时返回 `IDEMPOTENCY_CONFLICT`。
- Restore 后进入新 branch epoch。旧分支 receipt 可以保留用于审计或 retention，但不得拦截新分支的请求，也不得把已回退效果伪装成当前分支成功结果。
- Runtime 只可在任何 handler 尚未执行前重试 SQLite lock acquisition。Handler 开始后不自动重试；调用者收到冲突后必须重新读取 projection 并显式提交新 request。

### 错误模型

Runtime 使用稳定 error code 和结构化上下文；Pi adapter 可以把同一结果序列化给 GM，不依赖解析错误字符串。

| Error code | 含义 | 是否可能写入 state |
| --- | --- | --- |
| `REGISTRATION_INVALID` | 名称、版本、定义或依赖图非法 | 否 |
| `DEPENDENCY_UNAVAILABLE` | 依赖的 System module 不存在或未 ready | 否 |
| `CAPABILITY_UNAVAILABLE` | 请求的 capability 未安装或配置不完整 | 否 |
| `SYSTEM_NOT_REGISTERED` / `SYSTEM_NOT_READY` | operation 指向不可调用 module | 否 |
| `COMMAND_NOT_FOUND` | module 不声明该 command | 否 |
| `COMMAND_INPUT_INVALID` | module 拒绝 command input | 否 |
| `SYSTEM_STATE_INVALID` | 初始化、command、载入或 restore 后 state 校验失败 | 否 |
| `SYSTEM_VERSION_FUTURE` | payload/snapshot 版本高于当前 module | 否 |
| `MIGRATION_FAILED` | migration 缺失、抛错、未前进或结果非法 | 否 |
| `STATE_COMMIT_CONFLICT` | `expectedRevision` 与当前 revision 不一致 | 否 |
| `IDEMPOTENCY_CONFLICT` | 同一 requestId 对应不同 batch | 否 |
| `SNAPSHOT_INCOMPATIBLE` | snapshot namespace 集合无法由当前 registry 安全恢复 | 否 |
| `COMMAND_FAILED` | handler 的领域拒绝或未分类异常；包含 operation index/system/command | 否 |

失败 receipt 不伪装成成功结果。一个 batch 只有“全部提交”或“零写入”两种确定性状态结果。

## `commit_turn` 契约

未来 GM 工具 `commit_turn` 是 `SystemRuntime.commit()` 的 Pi adapter，不是另一个领域协议。LLM-visible input 只包含 operations：

```json
{
  "operations": [
    {
      "system": "gacha",
      "command": "draw",
      "input": { "banner": "standard", "count": 1 }
    }
  ]
}
```

Adapter 从真实 Pi tool call 解析当前 `saveId` 与 `sessionId`，以 `stableDigest([sessionId, toolCallId])` 注入 `requestId`，同时注入可信 caller identity，然后调用 `runtime.commit()`。同一 session/tool call 重放得到同一 requestId，不同 session 即使出现相同 toolCallId 也不得冲突。Adapter 不得把 Pi context 传给 System module。

- `commit_turn` 只推进确定性状态并返回 receipt；不接收 direction packet。
- 一次 GM 流程可以调用 0 次、1 次或多次 `commit_turn`；每次成功调用都是独立 State commit。
- 成功后 GM 继续工作；工具不得设置终止语义，也不得调用 Writer。
- 失败时本次 batch 零写入，并返回带 operation index/system/command 的结构化错误；GM 可以修正 input 后用新 request 重试。
- Tool result 可以展示公开 command result 和新 revision，但不得包含原始 System state。

状态推进链路固定为：

```text
GM -> commit_turn -> system transaction -> GM 继续工作
```

当前 `src/runtime/turn-commit.ts` 的 `commitTurn()` 是展示后的内部故事提交函数：它调用 Writer、投递正文并建立 story snapshot。它不等同于未来 GM 工具 `commit_turn`；P1 必须在命名、类型和测试中保持这两个入口可区分。

## 展示交接契约

状态推进、展示交接和故事提交是 3 条独立链路：

```text
状态推进：GM -> commit_turn -> system transaction -> GM 继续工作
展示交接：GM -> submit_direction_packet -> GM 结束 -> Writer
故事提交：Writer 成功 -> Pi 接受正文投递 -> story snapshot -> turn-rendered subscribers
```

- `submit_direction_packet` 不接受 System operation，也不修改核心或 System state。
- `needsRender=true` 才结束 GM 并进入 Writer；`needsRender=false` 直接回复，不创建 story snapshot。
- Writer 只读 projection 和 direction packet，不取得 System command 或写能力。
- Writer 失败时，之前成功的全部 State commit 继续有效；失败不创建 story snapshot，也不触发 `turn-rendered` 成功订阅。
- “正文已交付”在当前 Pi interface 下定义为 `sendMessage(..., { triggerTurn: false })` 返回且未抛错。仅写入进程内数组、登记定时器或进入待投递队列不算交付成功。
- Session 失效、等待 idle 超时或 `sendMessage` 抛错时，本次正文投递失败；不得创建 story snapshot，也不得发布 `turn-rendered`。
- Story snapshot 成功后才能发布 `turn-rendered`。OpenViking 与其他订阅者在事务外运行；它们失败不回滚状态、正文或 snapshot。
- 展示交接与 SQLite State commit 之间不存在分布式事务；本规格不引入跨 Pi/SQLite 两阶段提交。

## Story snapshot 与 `/roll`

### Snapshot 内容与捕获

Story snapshot 是核心拥有的完整确定性恢复 envelope，至少包含：

| 参与者 | 是否属于 snapshot | 表示 |
| --- | --- | --- |
| 核心 `RpState` | 是 | 带核心 schema version 的 payload |
| 当前 save 的全部 System namespace | 是 | 按 namespace 排序的 `{ version, opaquePayload }`；复制持久化 payload，不保存 runtime typed object |
| Capability-owned deterministic state | 是 | 例如已安装 RNG 的 save-local seed/cursor；由 capability adapter 提供 snapshot participant |
| Dynamic roles | 是 | 当前 save 的角色定义；restore 后重新 materialize，撤销被回退回合中新建或修改的角色 |
| Character trajectory | 是，保存 rollback cursor | Snapshot 保存每个角色的稳定 watermark；restore 删除 watermark 之后的 action，并拒绝保留覆盖被删 action 的 summary |
| Revision、branch epoch、idempotency receipt | 否 | 它们是单调并发与分支元数据；restore 不回退旧值，而是在成功事务中推进 revision 与 branch epoch |
| Hook cadence/fire-state | 否 | Engine bookkeeping 保持单调，不因 `/roll` 回退，避免同一 cadence 重复触发 |
| OpenViking memory | 否 | 外部最终一致记忆不参与确定性恢复 |
| Audit export、已执行外部 job side effect | 否 | 只能追加记录或显式补偿，不伪装成可回滚状态 |

捕获时，核心从 save system manifest/registry 枚举 namespace，并要求每个确定性 participant 都已 ready。Snapshot 中 System state 保存 versioned opaque payload，而不是解析后的对象；这让核心无需了解 schema，也能在 restore 时重新走 version 检查、migration 和 parser。

只有 Writer 成功且 Pi 已接受玩家可见故事正文投递后才捕获 snapshot。OOC 直接回复、Writer 失败、投递失败和仅有 State commit 的 GM 流程都不创建成功故事 snapshot。

### Restore 兼容性

Restore 在写入前对完整 envelope 预检：

- Snapshot 含有当前 registry 缺失的 System module：返回 `SNAPSHOT_INCOMPATIBLE`，当前 state 与 active snapshot chain 不变。
- Snapshot payload 是未来版本：返回 `SYSTEM_VERSION_FUTURE`，不猜测解析。
- Snapshot 旧版本需要 migration：在 restore transaction 的候选副本上逐步迁移并校验；任一步失败则整个 restore 零写入。
- 当前 registry 新增了 snapshot 中没有的 namespace：在同一 restore transaction 中用当前 `initialize()` 建立初始 state；失败则整个 restore 零写入。
- Dynamic roles、trajectory cursor 或其他确定性 participant 缺失/非法：视为 snapshot 不兼容，不做部分恢复。
- 升级前的 core-only snapshot 不直接 restore。Save 首次在新 runtime activation 成功后，核心以当时的 core、全部 ready System namespace、dynamic roles 与 trajectory 覆盖最新 legacy row，形成同一逻辑 turn number 的完整升级基线；它不猜测更早历史。
- 升级基线写入失败时，原 legacy row 与当前确定性 state 保持不变并返回明确错误。基线建立后，再完成 1 个新故事回合即可得到可供 `/roll` 使用的两个完整 envelope。
- 升级基线属于 schema migration，不计为新的成功故事回合，不增加 turn number，也不发布 `turn-rendered`。

### `/roll` 语义

`/roll` 面向最新一个成功故事回合，不面向某次 State commit：

1. 预检当前 registry、目标前驱 snapshot 和最新用户输入。
2. 在一个 restore transaction 中恢复前驱 snapshot 的核心、全部 System state、capability state 与 dynamic roles，并按 watermark 修剪 trajectory。
3. 在同一事务内把当前 save 的 revision 与 branch epoch 各加 1；旧分支 receipt 不参与新分支幂等判断。
4. 将被撤销 story turn 的 snapshot 从 active chain 移除或标记为 superseded；它不能再次成为后续 `/roll` 的恢复目标。
5. 重新 materialize dynamic roles，然后以普通 GM 流程重跑同一玩家输入。重跑期间的 `commit_turn`、Writer 失败和 snapshot 规则与普通流程完全一致。

若兼容性预检或 restore transaction 失败，当前状态、trajectory 和 snapshot chain 全部保持不变。Restore 已成功后，后续 rerun 不是同一 SQLite transaction：若 Writer 在 rerun 中失败，rerun 已成功完成的 State commit 继续有效，不恢复被撤销的旧 story turn，也不创建 replacement snapshot。

Rerun 成功时，新 snapshot 取代被撤销回合在 active chain 中的位置。连续多次 `/roll` 始终从同一个前驱 snapshot 重跑当前最新玩家输入；它用于反复重掷最新故事回合，不向更早历史逐级后退。物理保留 superseded snapshot 属于 retention implementation，不能改变 active chain 语义。

## 可选 capability

Capability 不是所有 System module 的基类字段。Module 只声明真实需要的 capability；核心在注册/启动阶段完成 binding。请求不可用 capability 时返回 `CAPABILITY_UNAVAILABLE`，该 module 不进入 ready，不能运行到一半再静默降级。

| Capability | Interface 语义 | 缺失与 rollback 语义 |
| --- | --- | --- |
| RNG | 核心拥有 save-local seed/stream identity；handler 只能从 transaction-scoped RNG 请求结果。Receipt 提供可复现标识，不暴露或自改 seed | 抽样和 cursor 与 State commit 一起提交/回滚；相同 snapshot、branch epoch 与 request 可复现。`/roll` 推进 branch epoch 后允许得到不同但仍可复现的结果；缺失时注册失败 |
| Jobs | Handler 只能在当前 transaction 中持久化 save-scoped job intent；worker 不获得 module state 写权限，结果必须通过带 requestId 的新 State commit 写回 | Pending intent 属于 snapshot participant，`/roll` 取消被撤销回合尚未开始的 intent；已执行外部 side effect 不回滚，重试必须幂等且有上限；缺失时注册失败 |
| Audit | Capability 接收 commit、operation、结果码、revision 和 caller identity；本地必要 audit 与 State commit 同事务，外部 export 在提交后异步进行 | 必要 audit 写入失败会使 commit 失败；export 失败不回滚。Audit append-only，不属于 story snapshot；保留策略由核心配置，不由 module 决定 |
| Visibility | Module 先生成 canonical projection，capability 再依据可信 audience 过滤；caller identity 由 adapter 注入，不能来自 operation input | 未知 audience/未声明字段默认拒绝；visibility module 请求 capability 但 adapter 不可用时启动失败，不能回退为全量 projection |

## 分阶段验收场景

P1 实现计划已拆分，按以下依赖顺序执行：

1. [System Registry、Namespaced Persistence 与 Migration](../plans/2026-07-10-system-registry-persistence-migration.md)
2. [System Transaction Runtime 与 Command Dispatch](../plans/2026-07-10-system-transaction-command-runtime.md)
3. [GM `commit_turn` Tool 与 Pi Binding](../plans/2026-07-10-gm-commit-turn-tool-binding.md)
4. [System Story Snapshot、Restore 与 `/roll`](../plans/2026-07-10-system-story-snapshot-roll.md)
5. [首个 System Probe 垂直切片](../plans/2026-07-10-first-system-probe-vertical-slice.md)

阶段边界固定如下：

| 阶段 | 必须完成的契约验收 |
| --- | --- |
| P1 | 完成 System runtime 底座；以生成系统做真实垂直切片；覆盖可升级自定义系统的 activation、command、snapshot migration 与 restore；验证 capability 缺失时启动失败 |
| P3 | 完成抽卡系统与 RNG capability 的端到端验收，再实现 jobs、audit、visibility 等按需 adapter |

P1 不实现 RNG、jobs、audit 或 visibility adapter，也不以抽卡探针完成为里程碑条件。抽卡探针保留为 P3 对 capability transaction 与 snapshot participant 的验收目标。

### P3：抽卡与 RNG 探针端到端

```text
register gacha(version=2, capability=RNG)
-> new save initialize { currency: 10, pity: 9, inventory: [] }
-> GM/commit_turn 调用 draw
-> State commit 原子扣除 3 currency、推进 pity、记录 RNG、发放物品
-> project 返回公开余额、pity 与物品摘要
-> Writer 成功后 snapshot 保存 gacha v2 opaque payload 与 RNG participant
-> /roll 恢复前驱 snapshot，抽卡 state 与 RNG cursor 一起恢复
```

验收断言：核心从不解析 `currency`、`pity` 或 `inventory`；余额不足或物品校验失败时，3 个字段与 RNG cursor 全部不变。相同 requestId 重试返回原 receipt，不重复扣费或发放。

### P1：生成系统探针端到端

```text
register generator(version=1) 与依赖系统 quest
-> new save initialize generator namespace
-> GM/commit_turn 依次提交 create_blueprint、quest.record_blueprint
-> 两个 operation 在同一个 State commit 中顺序执行
-> generator project 公开 blueprint 摘要，核心与 GM 不读取原始 payload
-> Writer 成功后 snapshot 保存两个 namespace
-> /roll 原子恢复两个 namespace，projection 从恢复后 state 重算
```

验收断言：`blueprint` 不进入核心 schema；generator 自己拒绝非法结构。若第 2 个 quest operation 失败，第 1 个 create operation、save revision 与 idempotency success receipt 均不提交。

### P1：可升级自定义系统探针端到端

```text
register progression(version=2)
-> existing save inspect v1 { level: 2, xp: 50 }
-> activation transaction 调用 v1 -> v2 migration
-> parse v2 { level: 2, xp: 50, perks: [] } 后进入 ready
-> GM/commit_turn 调用 progression command
-> State commit -> project -> story snapshot
-> /roll restore versioned payload；旧 snapshot 按同一 migration/parse 流程恢复
```

验收断言：migration 失败时原始 v1 payload 不变；v3 等未知未来版本返回 `SYSTEM_VERSION_FUTURE`。新 save 直接初始化 v2，不先生成 v1。

### 失败与恢复矩阵

| 阶段 | 场景 | 触发 | 可观察结果 |
| --- | --- | --- | --- |
| P3 | 单 System command 校验失败 | 抽卡余额不足、input 非法或 next state parser 拒绝 | `commit()` 返回对应 error code；全部 namespace、revision、RNG 和 receipt store 零写入 |
| P1 | 第 2 个 operation 失败 | generator 成功产生候选 blueprint，quest handler 随后拒绝 | 第 1 个候选 state 不提交，两个 projection 均保持 commit 前结果 |
| P1 | Migration 失败 | progression 的 v1 -> v2 migration 抛错或产出非法 v2 | Activation 失败，原始 v1 payload 保持可恢复，其他 module migration 也不部分提交 |
| P1 | Capability 缺失 | 测试 module 声明 RNG，但当前 runtime 没有 RNG adapter | 注册/启动返回 `CAPABILITY_UNAVAILABLE`；module 不进入 ready，任何 command 尚未执行 |
| P1 | Writer 在状态提交后失败 | 一个或多个 `commit_turn` 已成功，随后 Writer 抛错 | 已成功 State commit 与 revision 保留；不创建 story snapshot，不发布 `turn-rendered` |
| P1 | 正文投递失败 | Session 失效、idle 超时或 `sendMessage` 抛错 | 不创建 story snapshot，不发布 `turn-rendered`；已有 State commit 保留 |
| P1 | Legacy snapshot 升级 | Existing save 最新 snapshot 是 core-only row | Activation 后以当前完整 state 建立同 turn number 升级基线；再成功交付 1 个故事回合后 `/roll` 可用 |
| P1 | Restore 缺失 System module | Snapshot 含未注册 module | `/roll` 预检返回 `SNAPSHOT_INCOMPATIBLE`；核心、所有 System state、trajectory 与 active snapshot chain 不变 |
| P1 | Restore migration 失败 | Snapshot 中 progression 为 v1，当前 module 为 v2 且 migration 失败 | 整个 restore 零写入；当前 state 和被恢复 snapshot 都保持原样 |
| P1 | 并发 revision 冲突 | Request 携带过期 `expectedRevision` | 返回 `STATE_COMMIT_CONFLICT`；不自动重试 handler，调用者重新 project 后显式提交 |
| P1 | 重复 requestId | 同一 branch epoch 内相同 batch 重放，或同 key 携带不同 batch | 相同 batch 返回原 receipt；不同 batch 返回 `IDEMPOTENCY_CONFLICT`，两者都不重复执行 |
| P1 | Restore 后旧请求重放 | `/roll` 已推进 branch epoch，旧分支 receipt 仍存在 | 旧 receipt 不命中新分支；restore 前的 expected revision 必须冲突 |
| P1 | 连续 `/roll` | Replacement story turn 成功后再次 `/roll` | 再次从同一前驱 snapshot 重跑最新输入，不恢复 superseded 分支，也不逐级回到更早故事回合 |

### 删除测试

若删除 System runtime module，复杂度不会消失，而会重新散落：

| 落点 | 被迫重新承担的复杂度 |
| --- | --- |
| Pi tools | 每个工具自行解析 save、维护 batch 原子性、idempotency、revision 和错误序列化 |
| World loader | 自行理解每个系统的 schema、版本、依赖、capability 和启动顺序 |
| State store | 暴露 SQLite transaction，或增加所有 System state 的中央联合类型和 parser |
| Story snapshot 与 `/roll` | 手工枚举 namespace、复制 payload、处理 module 缺失/未来版本/migration，并分别恢复 dynamic roles 与 trajectory |
| 测试 | 针对存储函数、tool adapter 和每个系统重复测试事务规则，无法只穿过 `commit()`/`project()` interface |

因此 runtime 隐藏的是跨 5 类调用点重复出现的真实复杂度，而不是简单转发。删除后 locality 明显下降，说明 `commit()`、`project()` 与 `SystemDefinition` 构成了足够深的 module；继续拆出公开 repository port 或 per-system transaction interface 反而会变浅。

## 拒绝的设计

- **方案 A 作为外部 callback interface：** Pi/LLM 无法直接调用，必然产生第二套 JSON 协议。只有主要调用者转为可信 TypeScript 且需要过程式依赖时才重新考虑。
- **方案 C 的独立 dispatcher 作为第二写入口：** 会让 module-specific tools 绕过统一 `commit_turn`，削弱跨系统原子性。只有系统完全独立且不需要统一工具时才重新考虑。
- **统一 `DomainEvent` parser、统一 entity kind 或 reducer：** 核心会重新理解所有系统 schema，破坏 state ownership，并把新增系统的变化扩散到中央联合类型。
- **把 operation 持久化成 event ledger：** 当前只需要原子状态推进、snapshot 与恢复；operation envelope 是瞬时 command，不承担 event sourcing 或 replay。
- **向 System module 暴露 SQLite transaction/repository：** 会允许跨 namespace 写入，并迫使调用者与测试学习表结构。
- **System module 直接绑定 Pi session context：** 会把 save 定位、终止语义和 tool 生命周期混入领域逻辑，使 module 不能通过 runtime interface 独立测试。
- **Snapshot 保存解析后的 typed object：** 会让核心依赖 module 类型，并绕过 restore 时的 version/migration/parser。
- **Migration 与普通 command 混跑：** command 失败可能留下半迁移 state，错误结果也无法区分 activation 与领域拒绝。
- **所有系统强制继承 RNG、jobs、audit、visibility：** 会扩大 interface，并为没有真实变化点的依赖建立空 seam。

## 未决问题

无。P1 可以选择内部文件名和 TypeScript 泛型写法，但不得改变本规格的入口数量、职责、revision/branch epoch、幂等、投递确认、错误结果或 snapshot/roll 语义。RNG、jobs、audit、visibility adapter 保留到 P3。
