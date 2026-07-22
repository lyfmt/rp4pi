# 声明式 hooks 轴 —— 实现交接文档

> 目标:让世界包 `world.yaml` 的 `hooks:` 段能**声明式**地把通用逻辑挂到运行时生命周期节点上——与已完成的 subagents 轴同范式(世界只声明,底座提供机制)。

## 已和用户确认的方向(拍板决策)

- **就是做声明式 `hooks:` 世界包轴**(`schema.ts` 里 `hooks: unknown[]` 的预留插槽)。
- **锚点(anchor)** 第一批:`session_start` / `turn_start`(=before_agent_start)/ `turn_committed`(=turn 已渲染)。给足扩展性,后续可加。
- **通用逻辑类型**:`inject`(注入提示/notice)、`state`(声明式改 state)、`delegate`(委派 subagent,MVP 里实现为"注入指示 GM 委派"——hook 在 GM loop 外无法直接 spawn,自主 spawn 留作后续大工程,已诚实标注)。
- **范围**:MVP 骨架+范例,**分阶段**(H-A 契约/loader → H-B 引擎/管道 → H-C 范例 → H-D 文档),每阶段可 review、全绿再进。
- **cadence 门(every)**:按 save 持久化"上次触发点";多单位取**并集**(任一 elapsed 即触发);`/roll` 不回滚 fire-state(否则每次 undo 都会重触发)。

## 进度

### ✅ H-A 契约 + loader(已完成,全绿)

- `src/world/schema.ts`:新增 `HookAnchor`/`HOOK_ANCHORS`、`HookEvery`、`HookStateMutation`、`HookAction`(discriminated union:inject/state/delegate)、`HookSpec`;`LoadedWorld.hooks` 从 `unknown[]` 改为 `HookSpec[]`。
- `src/world/loader.ts`:新增 `parseHooks` + `parseHookAnchor`/`parseHookEvery`/`parseHookAction`/`parseHookMutations`,严格校验(slug、重名、未知锚点/动作、空 every、add 需数值等)。接进 `loadWorldFromDir`。
- 测试 `test/world/hooks-loader.test.ts`(15 例,全绿)。

### ✅ H-B 引擎 + 存储(代码+测试完成,**尚未接进 extension**)

- `src/state/sqlite.ts`:新增 `hook_fire_state` 表(`save_id, hook_name, last_turn, last_day, last_hour, fire_count, updated_at`,PK(save_id,hook_name))。**已同步改** `test/state/sqlite.test.ts` 的表清单断言。
- `src/state/hook-fire-state.ts`:`readHookFireState` / `recordHookFire`(upsert + fire_count++)。
- `src/hooks/cadence.ts`:纯函数 `shouldFire(every, last, now)`——无 every 恒触发、无 prior 首触发、多单位并集、gameHours 按绝对时间线(day*24+hour)跨天。
- `src/hooks/state-mutation.ts`:`applyHookMutations(draft, mutations)`——path 寻址 `attributes.<name>` / `time.hour`(进位到天,不低于第1天)/ `time.day` / `player.*` / `scene.summary`;add 仅数值,未寻址 path 抛错。
- `src/hooks/engine.ts`:`fireHooks({hooks, anchor, saveId, deps})`——筛锚点→查 cadence→dispatch(inject/state/delegate)→recordHookFire;单个 hook 抛错只 log 跳过不断批;delivery 经 `HookDelivery{prompt,notice}` 注入(可测)。turn 计数用 `latestStorySnapshotTurnNo`。
- 测试:`test/hooks/cadence.test.ts`(6)、`test/hooks/state-mutation.test.ts`(10)、`test/hooks/engine.test.ts`(7)。**全绿,全套 224 绿,typecheck 净。**
- `src/runtime/prose-message.ts`:已加 `HookNoticeMessage` + `createHookNoticeMessage(hook, text)`(notice 走 idle 投递用)。

### ✅ H-B 收尾 + H-C + H-D(已完成,232 绿、typecheck 净)

- **引擎接进 `extensions/core.ts`**:
  - prompt 投递不走 `sendMessage`,改为 `src/hooks/pending-prompts.ts` 的**双桶**(`active`/`pending`)+ core 的 `context` 钩子拼接。`session_start`/`turn_start` 的 prompt 进 `active`(本回合上下文);`turn_committed` 进 `pending`,下一回合 `before_agent_start` 的 `beginTurnPrompts()` 轮转晋级为 `active`。`context` 只读不排空 → 一回合内多次 model 调用都能看到。用 role:user 消息(中间态 system 并非所有 provider 接受),不落持久 entry ⇒ 不触发回合。
  - notice 走 `deliverWhenIdle` + `hook-notice` renderer(`src/hooks/wiring.ts` 的 `createHookDelivery`/`registerHookNoticeRenderer`),与 OV-error notice 同范式。
  - `session_start`:core 的 `before_agent_start` 里用 module 级 `Set<piSessionId>` 判首回合,fire 一次。`turn_start`:同处每回合 fire。`turn_committed`:`onTurnRendered`(turn-events 总线,和 OV memory 同一 seam)里 fire。
  - state 副作用经 `stateStore.mutateState`;`turn_committed` 的改动落 latest_states 成为下一回合起点,**不改本回合快照**(snapshot 在 commitTurn 时先落,hook 后跑)⇒ 与 `/roll` 不冲突。
- **H-C border-station 范例**(`worlds/border-station/world.yaml` 的 `hooks:` 段):`opening-atmosphere`(session_start / inject notice)、`clock-drift`(turn_committed / state time.hour+1)、`background-beat`(turn_committed / every turns:4 / inject prompt)。端到端静态验证 `test/world/hooks-border-station.test.ts`(loader 解析 + 引擎 dry-run 5 回合验时钟漂移 + cadence)。demo-flow e2e 也随之验证了 turn_committed 端到端(latest 比 snapshot 多 1 小时)。
- **H-D 文档 + _template**:`world-pack.md` 加「Hooks」大节(锚点表、every、三类 action、delegate 的 loop 外限制)+ manifest 表更新;`worlds/_template/world.yaml` 的 `hooks: []` 补四段注释骨架(inject/state/every/delegate)。
- 新测试:`test/hooks/wiring.test.ts`(6,双桶轮转 + delivery 路由 + renderer)、`test/world/hooks-border-station.test.ts`(2)。`test/helpers/extensions.ts` 的 `resetShared` 加 `resetHookPromptsForTest`。

**整个声明式 hooks 轴(H-A~H-D)全部完成。** ⚠️ 仅静态 + e2e(fake writer)验证,未跑真 live(需 provider)。**delegate 仍是 MVP 注入指示,未自主 spawn。**

---

## ⏭️ 原「待接手」记录(已全部完成,保留供追溯)

### H-B 收尾:把引擎接进 `extensions/core.ts`(**最关键、还没做**)

在 `extensions/core.ts` 里,用 `world.hooks` 驱动三个锚点。注意 core.ts 已有 `before_agent_start`(做 activateSave)。要点:

1. **构造 `HookDelivery`**:
   - `prompt(text)` → 需把文本喂给 GM。候选:`pi.sendMessage({customType, content}, {deliverAs:"nextTurn"/"followUp", triggerTurn:false})`,或走 `context` hook 注入。**需要确认 pi 的哪种投递能真正进 GM 上下文而不重复触发回合**(参考现有 idle-delivery.ts 的 triggerTurn:false 纪律)。
   - `notice(text)` → `deliverWhenIdle` + `runtimeMessageToOutbound(createHookNoticeMessage(...))`(见 openviking-memory/index.ts 的 notice 投递范式)。并注册 `hook-notice` 的 messageRenderer。
2. **`session_start`**:仅本会话首个 turn 触发一次。core.ts 现在没有 session_start 监听;pi.on 支持 `"session_start"`(types/pi.ts 已声明)。或在 before_agent_start 里用一个 module 级 Set 记 piSessionId 判首回合。
3. **`turn_start`**:在现有 `before_agent_start` 里 activateSave 之后调 `fireHooks(anchor:"turn_start")`。
4. **`turn_committed`**:订阅 `onTurnRendered`(turn-events.ts)——但那在 two-pass-render 扩展里 emit。core 可直接 `onTurnRendered(...)` 订阅(openviking-memory 就是这么做的),在回调里 `fireHooks(anchor:"turn_committed")`。
   - ⚠️ 注意:`turn_committed` 的 state 副作用(如 vigor-=2)发生在 turn 已提交之后,会写进 latest_states 但**不进本回合快照**——需想清楚它算下一回合的起点(应该 OK,但要确认 snapshot 时序,别和 /roll 冲突)。
   - ⚠️ delegate 在 turn_committed 注入的 prompt 要能触发**下一个** GM 回合(triggerTurn 语义),这点和 inject-as-prompt 的"不触发"纪律相反,需分别处理。

### H-C border-station 范例

在 `worlds/border-station/world.yaml` 的 `hooks: []` 里加 1~2 条,例如:
- 每回合体力自然回落:`on: turn_committed`,`do: {type: state, mutations: [{path: attributes.vigor, op: add, value: -1}]}`
- 定期后台事件:`on: turn_committed`,`every: {turns: 4}`,`do: {type: delegate, subagent: ..., task: ...}`(注意 border-station 现有 subagent 是 npc-generator/role-forger/wounded-messenger,没有事件生成器;要么复用要么先用 inject 范例)
- 端到端静态验证(loader 解析 + 引擎 dry-run)。

### H-D 文档 + _template

- `skills/development-guide/references/world-pack.md`:加「Hooks」大节(锚点表、every、三类 action、delegate 的 loop 外限制),更新 manifest 表 `hooks` 行(现写"预留插槽,先留空")。
- `worlds/_template/world.yaml`:`hooks: []` 补注释骨架(三类 action 各一段注释示例)。

## 验证命令

```bash
npm run typecheck
node --test                      # 全套(当前 224 绿)
node --test test/hooks/          # ⚠️ 目录级跑会报 MODULE_NOT_FOUND(疑似 node 版本对目录参数的怪异行为),
                                 # 但逐文件跑全绿;用 test/world/hooks-loader.test.ts 等逐个文件跑
```

> ⚠️ 记一笔:`node --test test/hooks/`(传目录)会 MODULE_NOT_FOUND,但 `node --test`(全跑)和逐文件跑都正常。接手时逐文件跑 hooks 测试,或直接全套跑。

## 关键约束(勿违背)

- hook 绝不能打断它所在的回合(引擎已 try/catch 单 hook)。
- state 副作用只走 `stateStore.mutateState`(和工具写一致)。
- delegate 不自主 spawn(MVP);若用户要真自主 spawn,那是单独大工程。
- fire-state 不随 /roll 回滚。
- 未 commit 到 git;当前分支 master。相关记忆见 `memory/subagent-feature.md`(同范式参考)。
