# 架构与设计决策

面向维护者：dsh-racing-code **为什么长这样**。使用说明见 [README.zh.md](../README.zh.md)，
流程文件格式见 [workflow-format.md](workflow-format.md)，依赖的官方契约与失效症状见
[compatibility.md](compatibility.md)，实施计划见 [development.md](development.md)。

实测环境：本机 DSH `0.2.0-rc.2`（source checkout `/home/liumenghan/deepseek-harness`），
profile `web`，`patchReload: live`，2026-10-17。

---

## 1. 目标与非目标

| | |
|---|---|
| **要做的** | 让**每个项目**用自己的一份 markdown（mermaid 流程图）声明工作流程与各阶段的模型；插件把它解析成阶段表，注入该系统提示，让主会话按图执行 |
| **不做的** | 不自己跑模型、不自己起子代理、不碰工作区文件（只读）、不改官方插件的行为、**不提供任何全局流程或兜底流程** |
| **不重造的** | 委派用官方 `subagent`；白名单用官方 `subagent-model-selection-settings`；插件配置持久化用官方 `settings`；提示段落与工具用官方 `systemPrompt` / `tools` 注册点 |

一句话：**本插件只拥有"读一份项目内的流程图并把它讲给模型听"这一件事**——一条提示段落、一个只读工具、
一份诊断。项目的流程文件存在与否，决定了插件在**这个项目里是否启用**。

### 1.1 项目名里的 racing 是什么

**同一个赛段，多个模型同时跑，各自一条赛道；CR 当裁判，把意见发回赛道改到通过为止。**

- **赛道（lane）**：图里的**并行组节点** `{{…}}` 的每条出边开一条 lane，
  各自在自己的 **git worktree** 里、用**不同的模型**独立完成同一件事（同一份契约、同一批测试）；
- **互不干扰**：物理隔离（worktree + 独立分支），赛道之间**永不互相看**，独立作答才有比较价值；
- **裁判（CR）**：所有赛道汇聚到一个**评审阶段**，在同一个标准下横向比较每条赛道的产物，
  给出每条的评分与问题清单；
- **复盘轮（review round）**：CR 不只是打分——它把**每条赛道自己的问题**发回**那条赛道原来的模型**，
  让它在原 worktree、原分支上改，改完复评；**改到每条赛道都没有阻塞问题，那一轮才给出胜者**。
  轮次有上限（`maxReviewRounds`，默认 2），超限停下问用户；
- **最有价值的信号是"共同问题"**：只有一条赛道犯的错，是模型能力/风格差异，让那条赛道改就是了；
  **两条独立赛道从同一份约束出发、独立工作却撞进同一个坑**，多半是**约束本身有歧义或有缺口**——
  这时候让它们各自绕过去，只会把"规格问题"伪装成"两条实现风格不同"。所以共同问题**不走赛道修订**，
  而是**停下来问用户**："要不要完善项目约束（流程文件 / AGENTS.md / 契约文档），然后再跑一轮？"

这条闭环是本插件存在的理由：把"多模型实现 → 横向评审 → 反馈修订 → 复评通过 → 反推约束缺口 → 用户拍板"
变成流程里的固定环节，而不是靠人记得去做。

## 2. 为什么必须自建插件（扩展点依据）

原生表面都不够用：

| 需求 | 原生现状 | 结论 |
|---|---|---|
| "阶段"这一概念 | 不存在 | 需要自己的数据结构 |
| 每个项目不同流程 | skill 是**文本说明**，模型"读了照着做"，没有任何结构化表面 | 需要自己解析 + 注入 |
| 每个阶段的模型 | 内置 Subagent 页只有 `enabled` + `allowedModels`（允许哪些），没有"哪个阶段用哪个" | 需要自己的解析与校验 |
| 流程配错要立刻可见 | 无 | 需要自己的诊断 |

DSH 已经给了全部所需接缝，所以**不需要改 DSH 源码**：

| 扩展点 | 事实 | 证据 |
|---|---|---|
| 项目根 | `agent.session.header.cwd`（会话创建时的绝对工作目录） | `packages/core/session/src/types.ts:104`；官方用法 `packages/context/file-reference-local/src/index.ts:122` |
| 按 agent（= 按项目）注册段落与工具 | `agent.ctx.inject([...], scope => scope.systemPrompt.section(...) / scope.tools.register(...))` + `ctx.on('agent/created' / 'agent/disposed')`；**通过 `agent.ctx` 注册的工具只对该 agent 可见** | `packages/context/file-reference-local/src/index.ts:69-91`；`packages/core/scope/README.md`（"a tool registered through `agent.ctx` is visible only to that agent"） |
| llm 目录（bootstrap 候选池）| `ctx.get('llm')` 的 `listProviders()` / `await listModels(providerId)`（返回 `{provider, id, name, description?}`）| 服务目录 `llm`；CR 阶段在 harness 实证（[compatibility.md](compatibility.md) §1.9）|
| `agent/created` 是**可等待**的串行事件 | 签名返回 `undefined \| Promise<undefined>`，`mode: serial` | 实测 `cordis_inspect_query Event` |
| 读项目文件 | `ctx.fs.resolve(path, { cwd })` / `readText` / `stat` / `watch`；**读取不受沙箱模式限制** | 服务目录 `fs`；`packages/fs/fs-sandbox/README.md`（"preserving the local filesystem's read behavior"） |
| 提示段落 | `ctx.systemPrompt.section({ name, order, text })`；`text` 是**同步**函数 | `packages/core/system-prompt/src/index.ts:66`；`SECTION_ORDERS` 见 `:125` |
| 设置命名空间 = profile 里该插件的**行 id** | `ns: entry.options.id as SettingsNamespace`；只有 `.volatile()` 字段进 GUI 表单 | `packages/settings/settings/src/index.ts:315`、`schema.ts` |
| 子代理可跨模型 | 委派工具行需 `modelSelectionSettings: true`；宿主设置 `enabled + allowedModels` 时才暴露 `provider`/`model` | `packages/subagent/tool-subagent/README.md`；`standard`/`ptc` preset 已带 |
| 并行委派（赛道） | 工具的 `run_in_background: true` 把子代理跑成后台 job；**工具没有 cwd 参数**，子代理继承父会话 cwd——所以 lane 只能靠"worktree 建在项目根之下 + 提示词里写死绝对路径"实现 | `packages/subagent/tool-subagent/src/index.ts:389-427`；cwd 继承见 [compatibility.md §1.9](compatibility.md) |
| 把 CR 的反馈发回同一条赛道 | 委派工具是 **continuable** 形态：后台跑完返回 `{ kind: 'continuable', subagentId }`，之后用 `send_message` 继续同一个子代理 | 实测 `Tool.listTools` 的 `subagent` 输出 schema；见 [compatibility.md §1.10](compatibility.md) |
| git worktree 隔离 | DSH **没有**原生 worktree 支持，用普通 `bash` 调 `git worktree add` 即可；沙箱的 `workspace-write` 允许写在项目根之下 | `grep -rli worktree packages apps` 无命中；`packages/fs/fs-sandbox/README.md` |

## 3. 唯一来源：项目里的那份流程图

```
        ┌─ 项目流程（唯一来源）─────────────────────────────────────┐
        │ <cwd>/doc/racing-code.md      （Config.projectFlowPath）   │  谁写：这个项目自己
        │   ├─ mermaid 图                阶段·顺序·并行·分支·回退·复核 │
        │   └─ 图内路由标注 / front-matter models:      每阶段用哪个模型 │
        └───────────────────────────────────────────────────────────┘
                          │
        ┌─────────────────┴─────────────────────────────────────────┐
        │ 文件不存在      → 插件**不启用**（不注入段落、不注册工具）  │
        │ 图解析失败      → 只注入一句诊断（不注入流程）              │
        │ 图解析成功      → 注入流程段落 + 注册 flow_stages          │
        └───────────────────────────────────────────────────────────┘
```

三个刻意的选择：

1. **没有全局层，也没有内置兜底**。前一版设计有"项目 → 全局 skill → 插件内置"三层，现在只剩一层。
   理由见 §11 的决策记录：一张全局表会让"项目之间的流程差异"退化成最大公约数；一个内置兜底会让
   "没写流程的项目"也被塞进一套别人定的阶段里；而兜底本身还得配一套"哪层赢了"的规则与诊断。
2. **模型也在这份文件里**（图内标注或 front-matter）。这样"这个项目怎么干活"是**一个文件、一次提交、
   一份 review**；换模型不必去第二个地方。
3. **"没声明就不启用"是硬行为**，不是提示。段落与工具都在 agent scope 里注册，所以没有流程文件的项目
   在提示词与工具列表里都看不到本插件的任何痕迹——连"你没写流程"这句话都不说（`FLOW_FILE_MISSING` 只存在于
   工具与日志里）。唯一例外是**声明了却写坏了**：那时只注入一句诊断，因为静默失败比不启用更糟。

### 为什么"没有路由"时用**当前会话模型**兜底

阶段 id 是项目自己起的，模型表不可能预先覆盖全部。三种兜底里：

- 报错不让跑 → 新增一个阶段就得先补配置，跨机器协作容易卡住；
- 猜一个"最像的"模型 → **最坏的选项**：看起来像配置好了，实际跑在没人预期的模型上；
- 用当前会话模型（= 委派时不传 `provider`/`model`，子代理继承父会话）→ 行为可预期、用户当场能感知，
  并且插件把这件事**明确说出来**（段落 + `flow_stages` + 一条"要固定就在标签第二行写上"的建议）。

选第三种。注意这与"路由必须在白名单内"不冲突：兜底路径**不指定路由**，因此不受白名单约束；
只有显式配置的路由才做白名单校验。

## 4. 只有一个半区：宿主半

```
浏览器（无插件代码）                          Host（lib/index.js + lib/flow.js + lib/sources.js）
──────────────────────────────────────       ────────────────────────────────────────────────
（没有设置页：配置在项目文件里）                 agents 生命周期
                                                 ctx.on('agent/created')  ← 可 await
                                                 ctx.on('agent/disposed')
                                                        │
                                                        ▼
                                                 agent.ctx.inject(['systemPrompt','tools'])
                                                   ├─ loadFlow(cwd) → 解析 + 合并路由 + 校验
                                                   ├─ systemPrompt.section(order 700, text: () => 缓存)
                                                   └─ tools.register(flow_stages)   ← 只有启用了才注册
                                                        │
                                                 fs.watch(<项目流程图>) → 失效缓存
```

**为什么不做浏览器半**：前一版的设置页存在的唯一理由是"编辑全局阶段表 / 路由表"。全局层取消之后，
没有任何宿主侧状态需要编辑——流程与模型都在项目文件里，那是编辑器和模型的主场。于是整个客户端半区
（`dsh.client`、`__ModuleLoader__` bundle、locale、`configForms`、模型目录下拉、插件自有 HTTP 路由）
一起消失：插件只剩宿主半 + 纯函数 + 取源。

### 缓存与刷新（关键约束）

`systemPrompt.section({ text })` 的 `text` 是**同步函数**，而读文件是异步的。所以：

- **每 agent 一份缓存**：`agent/created`（serial，可 await）里完成首次读取与解析，
  **首次读取在第一个模型步之前完成**；
- **last-known-good**：运行中重新解析失败时保留上一次成功的结果，只把诊断换成新的；
  文件被删除时例外——段落退化成一句 `FLOW_FILE_MISSING_AFTER_ENABLE`，不再显示已经不存在的流程；
- **失效**：`ctx.fs.watch` 监听项目流程图，变更即失效，下一次组装（下一个模型步）重新渲染；
- 段落文本本身**同步渲染**，不做任何 I/O。

**启用状态在 agent 创建时判定**：中途新建流程图不会给正在运行的会话注册工具（新会话才启用），
中途删除也不会注销工具（工具改为返回 `not_enabled`）。这条是刻意的取舍——工具注册的生命周期跟着 agent，
比跟着文件系统稳。

## 5. 数据模型（Config）

行 id / 设置命名空间都是 `racing-code`。**没有 GUI 表单**，所以字段不再需要 `.volatile()`：
默认值写在 bundle 补丁里，要改就在 profile 补丁的该行 `config` 里改。

```js
{
  enabled: true,                          // 总开关（多项目环境里想临时全关时用）
  projectFlowPath: 'doc/racing-code.md',  // 唯一来源，相对项目根
  maxStageRepeats: 3,                     // 回边护栏默认值（可被 front-matter 覆盖）
  maxLanes: 4,                            // 一个并行赛段最多几条 lane（可被 front-matter 覆盖）
  maxReviewRounds: 2,                     // 最多几轮"CR 反馈 → 赛道修订"（可被 front-matter 覆盖）
}
```

前一版设计里的 `globalSkill` / `builtinFlowPath` / `routes[]` / `announceInPrompt` /
`announceMissingProjectFile` / `syncAllowedModels` 全部删除——它们分别服务于全局层、内置层、GUI 预览与
白名单自动同步，而这四件事都不存在了。

## 6. 执行模型

### 编排者照图执行

主会话收到任务 → 提示段落给出**本项目的图**（阶段、顺序、并行赛道、分支、路由）→ 它按边的语义执行：

| 图上的形态 | 编排者的动作 |
|---|---|
| 顺序推进 | 一次**前台** `subagent`，显式 `provider`/`model`，提示词自包含 |
| **进入并行组** | 同一条 assistant 消息里把**所有 lane 同时**发起（后台运行），然后等它们全部结束 |
| **汇合点** | 必须等**所有** lane 结束（成功或失败）才开始，并把失败/缺失的 lane 明确记下来 |
| **分支** | 自己下结论（跑测试、看 diff），按条件边选一条，并把"判定 = 什么 → 下一阶段 = 谁"写进汇报 |
| **用户关口** | **必须**用 `ask_user_question`，条件边的文字就是给用户的选项；不得替用户决定 |
| **回边到并行组** | 开**新一轮**：只重跑被点名的 lane（未被点名的验证"确实没变"），不超过 `maxReviewRounds` |
| 终点 | 收口、汇报、结束本轮 |

插件不代跑判定、不起子代理、不做"确定性执行器"：判定本身就需要看真实结果（跑测试、看 diff），
插件没有比编排者更好的信息；真要一次跑完，那是 v2 的 `run_flow`（见 §12.1）。

### 并行赛道：worktree 是硬约束

"多个模型分别实现"必须**物理隔离**，否则 lane 之间会互相覆盖同一批文件，比较也失去意义：

```
<项目根>/.worktrees/implement-a/   ← 默认：目录由 laneDir 决定，分支 racing/implement-a
<项目根>/racing/implement-a/       ← laneDir: branch：目录 = 分支名（容器布局用这个）
<项目根>/racing/implement-b/       ← lane B 的 worktree，分支 racing/implement-b
```

四个不能让步的点：

1. **worktree 必须在项目根之下**。沙箱 `workspace-write` 只允许写工作区根与临时目录；建在 `../` 会被拒绝。
   用默认 `laneDir` 时它落在工作区内，会被 `git status` 看到，所以约定把 `.worktrees/` 写进 `.gitignore`（由流程里的 `plan` 阶段或人来做，
   而 `laneDir: branch` 的容器布局下车道目录在项目根、任何 worktree 之外，不需要 ignore 任何东西）；
   **插件不写工作区文件**）。
2. **子代理没有 cwd 参数**（§2 表）。lane 的提示词必须写死绝对路径：bash 用 `cd <worktree> && …`，
   文件工具用绝对路径。这条写进 lane 的阶段说明模板里（[workflow-format.md §11](workflow-format.md)）。
3. **跨轮复用，不新建赛道**：修订轮回到**同一个 worktree、同一个分支、同一个子代理（同一个模型）**。
   "轮次"不是"新赛道"——否则比较对象每轮都在变，历史结论全部作废。
4. **lane 结束后 worktree 保留**：CR 要读它、下一轮要用它、用户可能要手工挑取。只有 `commit` 完成后
   才清理落败 lane 的 worktree 目录，**分支一律保留**。

### CR 与复盘轮：反馈发回赛道，改到裁判通过为止

```
                         ┌── 单赛道问题：send_message 发回该赛道原来的子代理 ──┐
   cr ──► 分诊 ──────────┤                                                    │
    ▲                    └── 共同问题：走用户关口（约束缺口）                  │
    │                                                                         │
    └──────────────── verdict -- "否：按反馈修订" --> race（只重跑被点名的 lane）
```

1. **单赛道问题** → 反馈给**那条赛道原来的模型**，让它在原 worktree、原分支上改，改完**提交**，
   CR 下一轮只看**本轮新增 diff**；
2. **共同问题** → 走用户关口（约束缺口，见 §1.1）；用户选"接受现状"则记入**已接受清单**，
   后续轮次不再当阻塞问题（但仍写进最终报告）；
3. **每条 lane 都没有阻塞问题**的那一轮，CR 同时给出**胜者**（评分依据写清楚）→ `commit`；
4. 轮次上限 `maxReviewRounds`（默认 2）超限 → 停下问用户。

四个设计点：

- **为什么反馈给"原来的子代理"而不是新起一个**：它还记得自己写过什么、为什么这么写，
  比"新子代理 + 把 diff 塞进提示词"更省、更准。机制上用的是 continuable 子代理的 `send_message`
  （见 [compatibility.md §1.10](compatibility.md)）；原会话不可用时才退化为"同模型新起一个"。
- **为什么反馈要按赛道切分**：给 lane A 的消息里**只有 A 的问题**，不含另一条 lane 的问题与评分对比。
  一旦把横向比较灌给赛道，下一轮的"独立作答"就没了——那 CR 的比较也就没意义了。
- **为什么 CR 的模型不能是任何一条 lane 的模型**：自评有偏好。命中时给 `FLOW_CR_MODEL_REUSED` 警告。
- **报告要落到会话里**（可追溯）：编排者把 CR 报告写进给用户的汇报；需要长期留痕时由用户在项目里落盘，
  插件不主动写文件。

### 回边护栏

回边（重跑某阶段 / 开新一轮）是 TDD 循环与复盘轮的必要能力，也可能是死循环。护栏：

- 单阶段累计重复次数 ≤ `maxStageRepeats`（默认 3）、复盘轮 ≤ `maxReviewRounds`（默认 2）；
- 超限**停下问用户**，不允许无限重试；
- 每次换道都要把"判定 = 什么 → 下一阶段 = 谁"写进汇报（可追溯）。

护栏写在提示段落里（规则）而不是靠插件强制——插件不拦截委派、不掌握轮数。真正的强制留给 v2 的
`run_flow`（见 §12.1）。

### 为什么不在会话内换模型

同一会话中途改模型会让"哪一步是谁做的"不可追溯，且换模型后 KV cache/思考档位全部重算；
委派到子代理则每段都是干净的一次运行。子代理**不注入**流程段落（`agent.parentAgent !== undefined` 时跳过）：
它只做一个阶段，提示词由编排者给全，再塞一张图只会分散注意力。

## 7. 提示段落

| 项 | 取值 |
|---|---|
| 注册位置 | 每个 root agent 的 scope：`agent.ctx.inject(['systemPrompt','tools'], …)`（**不是**全局 `ctx.systemPrompt.section`） |
| 名字 | `racing-code:flow`（每个 agent scope 一份，互不冲突） |
| order | **700**（`TEAM_POLICY 600` 与 `PTC_ONLY 800` 之间）：先于"每个工具怎么用"被读到，而委派规则指向 order 2800 的 `subagent` 说明 |
| 文本来源 | 同步渲染 §4 的那份缓存 |
| 注入条件 | **只有 root agent，且本项目声明了可解析的流程图**；否则不注册 |
| 注入内容 | 生效文件路径、紧凑图（含并行组、判定与条件）、每阶段路由（未配置/未授权标出）、执行规则、复盘轮规则 |

段落里只放这五样（保持短），长提示词骨架放 `flow_stages` 按需取。

紧凑图示例：

```text
项目流程：/home/liumenghan/dsh-racing-code/doc/racing-code.md
design → (用户定稿?) --否--> design ; --是--> {要改代码吗?} --否：纯文档改动--> commit ; --是--> contract-tests
contract-tests → [race: implement-a ∥ implement-b] → cr
cr → {存在共同问题?} --有--> (用户决定：完善约束还是接受现状) ; --无--> {每条赛道都通过?}
     (用户决定) --完善约束--> design ; --接受现状--> {每条赛道都通过?}
     {每条赛道都通过?} --否：按反馈修订--> [race] ; --是--> commit
路由：design=opencode-go·mimo-v2.6-pro  contract-tests=opencode-go·glm-5.3-flash
      implement-a=opencode-go·deepseek-v4.1-flash  implement-b=kilo·kilo-auto/free
      cr=opencode-go·mimo-v2.6-pro  commit=kilo·kilo-auto/free
规则：每阶段前台 subagent 一次并显式传 provider/model；子代理看不到本会话，提示词必须自包含；
      [race: …] 是并行组：同一条消息里同时发起，各自在自己的 worktree（路径见 flow_stages；分支 racing/<lane-id>）
      里工作，提示词写死绝对路径；汇合点要等所有赛道结束后才开始；落败赛道的 worktree 不得擅自删除；
      cr 的问题按赛道切分，用 send_message 发回该赛道原来的子代理，在原 worktree/原分支上改并提交，
      最多 2 轮"反馈 → 修订"，改到每条赛道都通过才定胜负；共同问题走用户关口，不得让赛道各自绕过；
      判定自己下结论，用户关口必须 ask_user_question；同一阶段重复不超过 3 次，超限停下问用户。
```

## 8. `flow_stages` 工具契约

| | |
|---|---|
| 名字 | `flow_stages` |
| 注册位置 | 与段落一起注册在 `agent.ctx` 上（**没启用的项目里这个工具不存在**） |
| 参数 | `{ stage?: string }`（省略 = 返回全部阶段） |
| 取 flow 的对象 | 调用者的 `agent`（`ToolExecutionInput.agent`，`packages/core/tools/index.ts:339`）→ 它的 `session.header.cwd` |
| 返回 | 见下 |
| 副作用 | 无（只读；**现读现算**，不依赖缓存，因此永远反映磁盘上的最新版本） |
| 失败 | 不抛工具错误；未启用/解析失败时返回 `ok: false` + 诊断 |

```jsonc
{
  "ok": true,
  "file": "/path/to/proj/doc/racing-code.md",
  "entry": "design",                         // 来自图里的 `%% entry: <id>` 指令（有回边时必需）
  "nodes": [                                 // 图上四种节点都在这里，便于模型区分
    { "id": "contract-tests", "kind": "stage",    "label": "接口 + 测试" },
    { "id": "race",           "kind": "group",    "label": "并行实现" },
    { "id": "implement-a",    "kind": "stage",    "label": "实现 A", "lane": "implement-a" },
    { "id": "implement-b",    "kind": "stage",    "label": "实现 B", "lane": "implement-b" },
    { "id": "cr",             "kind": "stage",    "label": "CR 评审" },
    { "id": "common",         "kind": "decision", "label": "存在共同问题?" },
    { "id": "verdict",        "kind": "decision", "label": "每条赛道都通过?" },
    { "id": "gate",           "kind": "user_gate","label": "用户决定：完善约束还是接受现状" }
  ],
  "stages": [                                // 只列阶段；顺序 = 执行顺序
    { "id": "implement-a", "label": "实现 A",
      "lane": { "id": "implement-a", "worktree": "racing/implement-a", "branch": "racing/implement-a",
                "fanOutFrom": "race", "joinAt": "cr" },
      "route": { "provider": "opencode-go", "model": "deepseek-v4.1-flash", "authorized": true,
                 "source": "label" },        // label | front-matter | fallback
      "next": [ { "when": null, "to": "cr" } ],
      "instruction": "按 contract-tests 定下的契约实现……" }
  ],
  "joins": [ { "at": "cr", "lanes": ["implement-a", "implement-b"] } ],
  "loops": [                                 // 回边：开新一轮 / 重跑阶段
    { "kind": "review", "via": "verdict", "backTo": "race", "condition": "否：按反馈修订",
      "maxRounds": 2, "feedback": "按赛道切分后发回该赛道原子代理" },
    { "kind": "stage", "via": "gate", "backTo": "design", "condition": "完善约束", "maxRepeats": 3 }
  ],
  "mermaid": "flowchart TD\n  %% entry: design\n  …",   // 渲染出的「带模型的图」，可直接贴给用户
  "diagnostics": [ { "code": "FLOW_CR_MODEL_REUSED", "level": "warn", "stage": "cr", "message": "…" } ]
}
```

未启用时返回 `{ "ok": false, "notEnabled": true, "file": "<期望路径>", "reason": "missing" | "invalid",
"diagnostics": [...] }`（`invalid` 时带完整诊断，方便当场修）。

工具而不是只靠段落：模型不该**猜**模型 id；白名单校验结果要能被明确读到；lane/worktree/汇合点/回边与轮次
必须**算**出来而不是让模型自己推（入口、join、轮次都是图上的推导结果，见
[workflow-format.md §4.1](workflow-format.md)）；提示词骨架与"带模型的图"按需取用。

## 9. 失败模式与兜底

| 情况 | 行为 |
|---|---|
| 项目里没有流程图 | **不启用**：不注入段落、不注册工具；`FLOW_FILE_MISSING` 只出现在日志/工具里 |
| 文件存在但解析失败 | **不注入流程**，只注入**一句诊断**（含诊断码与文件路径），`flow_stages` 可查完整诊断；会话照常工作 |
| 文件存在但读不出来（权限/二进制） | `FLOW_FILE_UNREADABLE`，同上只注入一句诊断 |
| 会话中途文件被删/改名 | 段落退化为 `FLOW_FILE_MISSING_AFTER_ENABLE`（不再显示旧流程），工具返回 `not_enabled`；新会话即完全不启用 |
| 会话中途文件被改坏 | 保留上一版可用流程（last-known-good）+ 新诊断；下一次组装生效 |
| 某阶段没有路由 | 用当前会话模型兜底，标注 `fallback`，提示"要固定就写进标签第二行/front-matter" |
| 路由不在白名单 | 段落与工具标 `authorized: false`，并指出缺哪一条、加到哪里（内置 Subagent 设置页）；委派时官方工具会拒绝（硬约束，不是 bug） |
| 标签里写着模型但实际生效的是另一个 | `FLOW_LABEL_ROUTE_SHADOWED`（warn）：多半是把渲染产物贴回了文件 |
| 模型上游不可用 | `flow_stages` 只保证**格式**与白名单，不保证上游存在；症状与排查见 [compatibility.md §3](compatibility.md) |
| 项目不是 git 仓库 / git 不可用 | 扇出前**停下问用户**：初始化 git 后重试，或降级为单 lane 顺序实现；**不允许**悄悄串行 |
| 沙箱为 `read-only`，建不了 worktree | `git worktree add` 会写 `.git/` 与工作目录 → 被拒；编排者按沙箱提示申请**一次提权**，或问用户；插件本身不申请权限 |
| 一条 lane 的子代理失败/超时 | 其它 lane 继续跑完；汇合阶段（CR）必须等**全部** lane 结束，并在报告里明确标出哪条失败/缺失；只剩一条赛道时按单 lane 评审并写"共同问题**无法判定**" |
| 两条 lane 都失败 | CR 无法评审 → 停下问用户（重跑、换模型，还是回到契约阶段），不自行选一个凑合 |
| 赛道子代理已不可续 | `send_message` 失败 → 退化为"同 provider/model 新起一个 + 带上它自己的 diff 与反馈"，并在汇报里说明 |
| 修订轮被判"没变"的 lane | 先验证该 worktree 的 HEAD 与工作区都没变；真变了说明有人绕过流程改了它，按重新评审处理并给出诊断 |
| 反复不通过（轮次超限） | 到 `maxReviewRounds` 仍不通过 → **停下问用户**；不允许无限来回，也不允许编排者自己宣布"通过" |
| 段落组装 | **有流程时永远非空**；没流程时根本不注册。组装失败会让整个会话发不出请求，这条是红线 |

## 10. 边界与不变量

- 插件只读工作区里的**一个**约定路径（`Config.projectFlowPath`）：不删、不执行命令、不起子进程。**唯一的写**：用户两次确认（确认流程 → 逐节点选模型）后，由 `racing_code_init` 写 `Config.projectFlowPath` 这**一个**文件（`createIfAbsent`；`force` → `replaceIfVersion`），其余一切零写入；缺文件时**零段落**、只有该工具（`bootstrapEnabled` 可关）。 另外，**代码里不得出现具体的阶段名或模型名**用于分支或文案：阶段与模型只有一个来源——项目流程文件的**声明**与**用户的选择**（模板默认图的阶段 id 只是那张图的定义，不是判断依据）。
- 插件**不建 worktree、不合分支、不删分支**：`git worktree add/remove`、`git merge` 全部由编排者用 bash
  在阶段里做；插件只把"lane 必须隔离、worktree 放哪、结束后不许擅自删"讲清楚。
- 插件**不代跑判定、不拦截委派、不掌握轮数**：分支、赛道、复盘轮与护栏靠提示段落 + 工具输出讲清楚，
  不是强制机制。
- 插件**不参与赛道修订**：反馈怎么切分、发给哪个子代理、轮次怎么数，全由编排者按段落规则做
  （插件只把 lane、join、回边与上限**算出来**告诉它）。
- 插件**不代理模型请求**，也不改写别的插件的 Config。
- **没有全局状态**：插件的 Config 只有五个开关（§5）；流程与模型的唯一事实来源是项目里的那份 markdown。
- 已存在的会话不追溯：段落按 agent 注册，改动对**下一个模型步**生效；但子代理模型白名单仍是
  **会话组合时采样一次**的，改白名单仍需新开会话。

## 11. 决策记录

| 决策 | 选择 | 被否掉的方案与原因 |
|---|---|---|
| 流程粒度 | **逐项目**，项目内 markdown | 全局一张表：项目之间流程必然不同，全局表会退化成"所有人共用一个最大公约数" |
| 有没有兜底流程 | **没有**：没声明就不启用 | 内置默认流程：没写流程的项目也被塞进别人定的阶段；而且"哪层赢"要多一套规则与诊断；用户明确要求删掉全局配置（2026-10-17） |
| 模型写在哪 | **同一份文件里**：图内标注 + front-matter | 全局模型表：换一个模型要改全局，项目无法各自演进；模型腐烂（见 compatibility §3）会一次性污染所有项目 |
| 图与模型的关系 | 图定义**阶段与结构**，路由是**同一文件里的另一段**，渲染方向单向 | 把渲染产物（带模型的图）当来源：标签里的模型名会变成过期装饰，产生"看着是 A、跑的是 B" |
| 缺路由时 | 用**当前会话模型**兜底 + 明确提示 | 报错：新增阶段就卡住；猜模型：静默跑错模型 |
| 分支 | **v1 就支持**条件边与回边 | 只支持单链：TDD 的"红了回实现"是主线场景 |
| 并行怎么表达 | **显式的并行组节点** `{{…}}`，每个出边一条 lane | 让阶段的多条无条件出边表示并行：**回边没法指回"这一组赛道"**，"再来一轮"只能重新画一批节点 |
| lane 的目录 | 由流程文件的 `laneDir` 决定（默认 `.worktrees`；`branch` = 目录即分支名） | 写死 `.worktrees/`：在"项目目录是 worktree 容器、每个分支一个目录"的布局里（`main/` 与 `racing/<lane-id>/` 同级）显得格格不入；写死"目录 = 分支名"：普通仓库里会和项目自己的目录撞名，且要 ignore `racing/`。可配一次，两种布局都自然 |
| 新项目引导 | 缺文件时**沉默**，只有用户明确指令才由 `racing_code_init` 引导；**两次用户介入**（确认流程 → 逐节点选模型）；非赛道节点默认 `session`（显式哨兵） | 自动挑模型会把「用户的选择」变成脚本的猜测；两次介入把结构与模型分开确认，代价是多一轮对话 |
| lane 的隔离方式 | **git worktree（必须在项目根之下）** | 同一个工作区串行：多个模型互相覆盖，没有可比性；建在 `../`：沙箱直接拒绝 |
| 修订轮由谁改 | **发回该赛道原来的模型/原子代理** | CR 直接动手改：评审与实现同一只手；换一个新子代理改：丢掉"它为什么这么写"的上下文 |
| 反馈的粒度 | **按赛道切分**，只给该赛道自己的问题 | 把横向比较一起发过去：下一轮的"独立作答"就没了 |
| 共同问题的处置 | 走用户关口，**不**让赛道各自绕过 | 让两条赛道分别"修"一个规格歧义：会得到两种互不相容的解释，把真正的约束缺口掩盖掉 |
| 定胜负的时机 | **全部赛道都通过**的那一轮由 CR 给出 | 谁先通过谁赢：奖励"少做少错" |
| CR 的模型 | **不复用任何 lane 的模型**（命中给警告） | 复用：自评有偏好，横向比较失去意义 |
| 解析失败 | 只注入诊断，**不启用流程** | 继续用旧流程：悄悄跑一套和文件不一致的流程，比停下来说清楚更危险 |
| 注入对象 | 只注入 **root agent** | 注入所有 agent：子代理只做一个阶段，多一张图是噪声 |
| 有没有 GUI | **没有**：不做浏览器半 | 前一版设置页只为编辑全局阶段表/路由表；全局层取消后没有任何宿主侧状态要编辑；预览还需要插件自有 HTTP 路由与客户端读文件能力，成本全为"展示一份本来就写在项目里的文件" |
| 判定执行者 | **编排者**自己判（用户关口由用户判） | 插件代跑判定：插件没有比编排者更好的信息，且要碰测试/命令，越界 |

## 12. 未决问题

1. **要不要确定性执行器？** v2 的 `run_flow`：由插件按图驱动子代理，段间自动推进，分支条件由插件求值。
   实现路径已有官方先例——`tool-ralph` 是"an ordinary plugin over `ctx.workflowEngine` and `ctx.subagents`"，
   racing-code 同样可以把"图"编译成 workflow 脚本，而不是自己管子进程与生命周期。v1 是"编排者照图执行"，
   人在每段之间看得到、插得上话。
2. **护栏要不要硬？** `maxStageRepeats` / `maxLanes` / `maxReviewRounds` 现在只是提示词规则；
   硬强制需要插件数轮次（挂 `session/event` 统计阶段委派），与"插件不参与请求路径"的边界冲突。
3. ~~要不要提供「新建流程文件」的入口？~~ **已落地**（v0.2.0：`racing_code_init` 引导工具，见 [bootstrap.md](bootstrap.md)）。
   或者一个把模板打印到 stdout 的小工具（都不需要 GUI）。
4. **要不要"取长补短"？** 现在是"反馈改到全部通过 → 选胜者 + 保留落败分支供人挑取"；
   自动合成第三条分支属于 v2。
5. **落败 worktree 谁清理？** 现在是 `commit` 阶段清理目录、保留分支。
6. **复盘轮要不要逐赛道独立收敛？** 现在是"一条不通过就整轮再评（只重跑被点名的赛道）"。
7. **CR 的评分标准要不要可配？** 现在评分维度写在 `cr` 的阶段说明里。
8. **模型表要不要支持"按 preset/会话类型"分列？** 例如同一个阶段，在交互会话里用贵模型、
   在子代理里用便宜模型。
