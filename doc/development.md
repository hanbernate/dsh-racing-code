# 开发计划

面向实现者。本页是**唯一**的施工图：里程碑、每个模块的接口契约、每步的验收标准、风险与未决。
格式与语义的规范在 [workflow-format.md](workflow-format.md)，设计依据在 [architecture.md](architecture.md)，
官方契约与失效症状在 [compatibility.md](compatibility.md)。

交付物是**一个宿主半插件**（没有浏览器半），外加纯函数层、取源层与 bootstrap 纯函数层；
v0.1.0（M0–M5）与 v0.2.0（M6–M8）均已实现；M9–M11 是 v0.2.0 之上的语义修订（阶段按声明分流、判定=带建议的用户关口）。

---

## 0. 范围

| | |
|---|---|
| **要做** | 读项目里的 `doc/racing-code.md` → 解析 mermaid 图与模型表 → 给该项目 root agent 注入系统提示段落 + 注册 `flow_stages` 工具；项目没声明就**什么都不做** |
| **不做** | 不做 GUI、不做全局/内置流程、不委派、不建 worktree、不跑判定、不数轮次、不写工作区（v0.2 起唯一例外：用户两次确认后由 `racing_code_init` 写 `projectFlowPath` 这一个文件） |
| **可以晚做** | `run_flow` 确定性执行器（v2）；"打印流程模板"的小工具已落地为 `racing_code_init`（v0.2.0） |

**总原则**（贯穿所有里程碑）：

1. **没声明就不启用**：文件不存在 → 零注入、零工具注册、零日志噪声；
2. **声明了就不能静默失败**：解析失败必须留一句诊断；
3. **系统提示组装绝不能被搞挂**：任何输入下，段落文本要么是完整的流程，要么是一句诊断，**永远不会抛错**。

## 1. 前置条件（已完成，2026-10-17）

已写入 `~/.dsh/profiles/web/cordis.patch.yml` 并用 `node apps/cli/lib/bin.js --profile web --dump-config` 复核：

| 项 | 状态 |
|---|---|
| `llm-pi-ai` → `opencode-go.models` 加入 `mimo-v2.6-pro` | ✅ 已生效 |
| `llm-pi-ai` → `kilo` 改用 `headers: { x-api-key: FREE, authorization: Bearer }` | ✅ 已生效（原因见 [compatibility.md](compatibility.md) §2.2；**不是**"keyless"） |
| `subagent-model-selection-settings` → `enabled: true` + 5 条 `allowedModels` | ✅ 已生效；**图上用到的每条路由都要在这里**（手工维护，插件不再自动并入） |
| 委派工具行的 `modelSelectionSettings: true` | ✅ 官方 `standard` / `ptc` preset 自带，无需改 |
| 四条示例路由的真实调用 | ✅ 已用 workflow 探针各跑通一次；`mimo-v2.6-flash` 流式被上游挡住，故示例里用 `glm-5.3-flash` |

### 仓库布局（2026-10-17 起）：worktree 容器

项目目录 `/home/liumenghan/dsh-racing-code` **不再是仓库工作区**，而是容器：

```text
dsh-racing-code/
├── .bare/    裸仓库（对象 / refs / origin）
├── .git      文件：gitdir: ./.bare
└── main/     分支 main 的 worktree（代码、测试、文档都在这里）
```

实现与验证时注意三条：

1. **工作区命令都在 `main/` 里跑**：`git -C /home/liumenghan/dsh-racing-code/main status`、
   `cd /home/liumenghan/dsh-racing-code/main && npm test`；容器根只做整仓操作
   （`git worktree list` / `fetch` / `branch`）。容器根跑 `git status` 会报 `must be run in a work tree`，这是预期。
2. **插件从 `main/` 安装**：`install_bundle /home/liumenghan/dsh-racing-code/main`（`package.json` 在 worktree 里）。
   换 worktree 改代码后要重新安装指向新目录，并**重启 dsh** 加载新的 JS 模块代
   （本次得到 `application: restart-required`，重启后生效）。
3. **流程文件指路**：会话 cwd 是容器根，所以 profile 补丁里该行配
   `projectFlowPath: main/doc/racing-code.md`（被跟踪的那一份）。

## 2. 里程碑总览

| # | 里程碑 | 产物 | 依赖 | 规模 | 状态 |
|---|---|---|---|---|---|
| **M0** | 仓库骨架与包元数据 | `package.json`、`cordis.patch.yml`、`locale/`、`test/` | — | 小 | ✅ 完成 |
| **M1** | 纯函数层 `lib/flow.js` | 解析 / 校验 / 合并 / 渲染（无 I/O、无 DSH 依赖） | — | **大** | ✅ 完成（38 用例） |
| **M2** | 取源与启用判定 `lib/sources.js` | 读文件、判定五态、`fs.watch` | M1 | 小 | ✅ 完成（13 用例） |
| **M3** | 宿主半 `lib/index.js` | Config、按 agent 注册段落与工具、缓存与热刷新 | M1 M2 | 中 | ✅ 完成（14 用例） |
| **M4** | 端到端验收 | 安装/注册/段落进 prompt/热刷新/配置热生效/"没声明就不启用" | M3 | 中 | ✅ 完成（**赛道 e2e 按用户决定暂缓**，见下） |
| **M5** | 文档回填 | README 状态、实测版本号、契约漂移、未决收敛 | M4 | 小 | ✅ 完成 |
| **M6** | 契约与红测试 | `lib/bootstrap.js` 骨架 + `test/bootstrap.test.mjs` + host/flow/package 用例改动（契约提交 `30643ec`） | M5 | 中 | ✅ 完成（96 用例先红 25） |
| **M7** | 双赛道 + CR + 复盘轮 | `racing/implement-a`（`9549c0c`）、`racing/implement-b`（`512f85a`→`2a4747c`）；CR 两轮 + `gate`/`confirm` 两个用户关口 | M6 | 大 | ✅ 完成（胜者 **implement-b**，已 cherry-pick 进 main） |
| **M8** | 文档回填与收口 | 版本 0.2.0、README/locale/development 回填、真实新会话 e2e | M7 | 小 | ✅ 文档回填完成；e2e 三条 **待真实新会话实测** |
| **M9** | 契约与红测试（按声明分流） | 执行按声明分流（无按阶段命名的例外）、判定=带建议的用户关口、渲染两种标记（设计/契约 `eb9a86b`/`e4905ba`/`208b845`/`c55d217`/`054cdce`） | M8 | 中 | ✅ 完成（先红后绿） |
| **M10** | 双赛道 + CR + 用户判定 | `racing/implement-a`（`dce5ce4`→`3ef6d93`→`51b347e`）、`racing/implement-b`（`57358cc`→`82736ef`→`4074640`）；CR 三轮 + 用户两次判定（「A 通过」） | M9 | 大 | ✅ 完成（胜者 **implement-a**） |
| **M11** | 合入 0.0.x 与文档回填 | 胜者按 `d86c5be`/`6b5d6ae`/`9f9ec78` 合入 `0.0.x`（**不直接落 `main`**），104/104 全绿；五个文档回填 | M10 | 小 | ✅ 文档回填完成；e2e 三条仍 **待真实新会话实测** |

**M4 的边界**：用户在 2026-10-17 明确选择"先不跑双赛道"，所以"两条 lane + worktree + CR 复盘轮"这一段
只有规程与提示词模板（[workflow-format.md](workflow-format.md) §5/§8/§11）与单元测试覆盖，**在 M4 时没有真实跑过**
（M7 的真实双赛道 + CR 两轮已补齐这一段，见「M6–M8」小节）；
其余验收项全部在真实会话里验过，证据见 §M4 的表。

每个里程碑的**完成定义**：本节表格里的产物 +

- 该里程碑的测试全绿（`node --test`）；
- 验收清单里的每一条都在**真实运行**里看到过（不是"应该会"）；
- 没有把"下一步要做的事"写成注释留在代码里。

---

## M0. 仓库骨架（小）

```text
package.json          name: dsh-racing-code，type: module，engines: node>=22
                      exports: { ".": "./lib/index.js", "./cordis.patch.yml": …, "./package.json": … }
                      dsh.bundle.patch: "./cordis.patch.yml"          # 注意：没有 dsh.client
                      scripts: { test: "node --test", prepublishOnly: "npm test" }
                      files: [lib, locale, doc, cordis.patch.yml, README.md, README.zh.md]
cordis.patch.yml      - insert:
                          - id: racing-code
                            name: 'dsh-racing-code'
                            config:
                              enabled: true
                              projectFlowPath: doc/racing-code.md
                              maxStageRepeats: 3
                              maxLanes: 4
                              maxReviewRounds: 2
locale/zh.json        插件卡片标题/描述（Plugin Manager 不激活插件也要能读；文案要说明"按项目启用"）
locale/en.json
lib/  test/           空目录，等 M1 起
```

**约定（沿用 dsh-save-button）**：零构建、零依赖、手写 JS；`main` 指向 `lib/index.js`。
**不要**声明 `dsh.client`——本插件没有浏览器半（[architecture.md §4](architecture.md)）。

**验收**

- `plugin_manager install_bundle /home/liumenghan/dsh-racing-code` → `application: applied`，`warnings` 为空；
- `list_bundles` 里有它（`dsh-racing-code`，`installed: true`，`enabled: true`）；
- `Config.listConfigs { name: "dsh-racing-code" }` 查得到 `patchId: racing-code` 的行，且 `status` 是
  **`unsupported`**——这是**预期**：官方把该状态定义为"它的 Config 不是原生 Schemastery 图"
  （`packages/extensions/tool-cordis/src/config.ts:16`），而我们按零依赖约定用 `~standard` schema
  （Loader 接受它、fiber 正常在跑；`unsupported` 只表示 inspect 投影画不出表单）。
  **所以"schema 里恰好五个字段"这条不能用 inspect 验**，改用行为验：把补丁里的 `projectFlowPath` 指向一个
  不存在的路径 → 会话里 `flow_stages` 立刻改口说"未启用"；改回来 → 立刻恢复（`patchReload: live`），
  见 M4 第 2 步；
- 装完**不做任何事**：随便开一个没有流程文件的项目，会话里没有段落、没有 `flow_stages`（这条在 M3 复验）。

## M1. 纯函数层 `lib/flow.js`（大）

无 DSH 依赖、无 I/O、可单测。按 `tdd-interface-first`：**先写签名与 JSDoc 契约 → 先写测试（红）→ 再实现（绿）**。

| 函数 | 契约要点 |
|---|---|
| `parseFrontMatter(text)` | `{ data, problems[] }`；受限 YAML 子集；越界给 `FLOW_YAML_UNSUPPORTED`，**不抛** |
| `parseYamlSubset(text)` | 子集解析器：注释、`key: value`、两空格缩进、标量；不支持数组/流式/多行 |
| `parseMermaid(text)` | 第一块 ```mermaid → `{ nodes, edges, entry?, problems[] }`；四种形状；识别 `%% entry:`；忽略 `%%` 注释、`subgraph/end`、`classDef/class/style/linkStyle/click`、`direction` |
| `parseNodeLabel(label)` | 拆出显示名 + 可选路由：第二行匹配 `^[A-Za-z0-9._/-]+\s*[·/]\s*[A-Za-z0-9._/-]+$` 才算路由（中文第二行不算） |
| `resolveEntry(nodes, edges, declared)` | §4.1 的合法入口判定 → 唯一 / `FLOW_AMBIGUOUS_ENTRY`（列出候选）/ `FLOW_NO_ENTRY` / `FLOW_BAD_ENTRY` |
| `classifyEdges(nodes, edges)` | 四种出发点的出边语义；违规给 `FLOW_UNLABELED_BACK_EDGE`、`FLOW_STAGE_FANOUT_NOT_GROUP`、`FLOW_GROUP_NEEDS_TWO_LANES`、`FLOW_GROUP_LABELED_EDGE`、`FLOW_DECISION_DEAD_END`、`FLOW_DECISION_UNLABELED_EDGE`、`FLOW_AMBIGUOUS_FANOUT` |
| `classifyBackEdges(nodes, edges, entry)` | DFS 标回边；回边无条件 → `FLOW_UNLABELED_BACK_EDGE`；残余环 → `FLOW_CYCLE_WITHOUT_ORDER` |
| `buildLanes(nodes, edges, group)` | lane 列表（组后继 → join 的直线路径）、汇合点（去掉回边的 DAG 上拓扑序最靠前）；`FLOW_NO_JOIN`、`FLOW_NESTED_FANOUT`、`FLOW_BRANCH_INSIDE_LANE`、`FLOW_TOO_MANY_LANES` |
| `buildLoops(nodes, edges, backEdges)` | 回边 → `loops[]`：目标是组 = `kind:'review'`（带 `maxRounds`，缺评审阶段给 `FLOW_LOOP_WITHOUT_REVIEW`），目标是阶段 = `kind:'stage'`（带 `maxRepeats`） |
| `buildFlow(parsed, opts)` | 组装 `{ ok, entry, nodes[], stages[], joins[], loops[], problems[] }`；任一 error 置 `ok:false` |
| `mergeRoutes(stages, frontMatter, sessionRoute)` | 图内标注 > front-matter；都没有 → `{ fallback: true }` |
| `checkAuthorized(routes, allowedModels)` | 标 `authorized`；白名单读不到时**跳过校验**（不误报） |
| `checkReviewer(routes, lanes)` | CR 与任一 lane 同模型 → `FLOW_CR_MODEL_REUSED` |
| `checkLabelShadowing(nodes, routes)` | 标签第二行**不是**路由（被忽略）而 front-matter 另有生效值 → `FLOW_LABEL_ROUTE_SHADOWED` |
| `attachInstructions(nodes, markdown)` | 抽 `### <id>` 小节作为 `instruction`（只有阶段需要） |
| `renderPolicySection(resolved)` | 紧凑图 + 路由 + 执行规则（含赛道子代理显示名 `<节点词干>-<model>`、逐节点）+ 复盘轮规则；**任何输入都返回非空字符串** |
| `laneAgentName(nodeId, route)` | 赛道阶段子代理显示名 `<节点词干>-<model>`（[workflow-format.md](workflow-format.md) §5.3，逐节点）；`laneAgentNameLine(stages)` 渲染 `flow_stages` 的「子代理显示名」行 |
| `renderMermaid(resolved)` | 渲染"带模型的图"（路由填进标签；未声明的非 lane 标"（在当前会话直接执行）"、lane 标"（用当前会话模型委派）"，未授权标 ⚠），供 `flow_stages.mermaid` |
| `diagnose(problems)` | 诊断码 → 人话（含"改哪里"） |

**验收**：`node --test test/flow.test.mjs` 全绿，至少覆盖：

- **绝对底线**：空输入、只有 front-matter、只有空 mermaid 块、随机垃圾 → `renderPolicySection` 都返回非空；
- front-matter：缺失（按版本 1）、版本 2、数组/流式写法、三个护栏值被覆盖；
- mermaid：四种形状、链式边、`-- "条件" -->` 与 `-->|条件|`、忽略清单里的每一种；
- **入口**：`%% entry:` 正确/指向不存在/指向非合法入口；无回边的图自动取唯一根；有回边又不写指令 →
  `FLOW_AMBIGUOUS_ENTRY` 且候选列表非空；
- **并行组**：两条/三条 lane、lane 内多阶段（共享 worktree）、join 正确；五个 lane 相关 error 码各一例；
- **回边与轮次**：`verdict --"否"--> race` → `loops[0]` 是 `kind:'review'` 且 `maxRounds` 取自 front-matter；
  回边指回阶段 → `kind:'stage'`；无条件回边、非回边成环各一例；
- **模型表**：图内标注优先、front-matter 兜底、两处都没有 → `fallback`；标签第二行写中文 → **不**被当路由；
  标签上写着模型但实际生效另一个 → `FLOW_LABEL_ROUTE_SHADOWED`；白名单命中/未命中/白名单不可读；
- **每个 error 级诊断码各一个反例**（见规范 §9 的表，逐个对照，不许漏）；
- **真实文件当夹具**：`doc/racing-code.md` 必须解析成功（把它当"规范与实现不漂移"的守门测试）。

## M2. 取源与启用判定 `lib/sources.js`（小）

输入是 `{ fs }` 与 `cwd`，不依赖 agent。

| 函数 | 契约 |
|---|---|
| `readProjectFlow(fs, cwd, projectFlowPath)` | 返回 `{ status: 'missing' \| 'unreadable' \| 'ok', file, text?, error? }`；相对路径以 `cwd` 为基准，**只读这一个路径** |
| `loadFlow(fs, cwd, config)` | 串起 M1：`missing` → `{ enabled: false, reason: 'missing' }`；`ok` 但 `ok:false` → `{ enabled: false, reason: 'invalid', diagnostics }`；成功 → `{ enabled: true, resolved }` |
| `watchFlow(ctx, file, onChange)` | `ctx.fs.watch` + 一个 `AbortController`；返回 disposer；文件不存在时不挂 watcher（跨会话轮询由新建会话承担） |

**注意**：`ctx.fs.resolve(path, { cwd })` 的 `cwd` 只是相对路径基准；**读取不受沙箱限制**，不需要提权。
所有 `FsError` 按 `code` 分支（`FS_NOT_FOUND` 是正常路径），**任何失败都不抛**。

**验收**：三种状态的纯逻辑用假 `fs` 覆盖；真机上用一个不存在的路径、一个坏文件、一个正常文件各验一次。

## M3. 宿主半 `lib/index.js`（中）

1. `export const Config`：M0 的五个字段，**不用 `.volatile()`**（没有表单）；
2. `export const inject = ['agents', 'fs', 'systemPrompt', 'tools', 'subagentModelSelection']`
   （`subagentModelSelection` 只用来读白名单，读不到就跳过校验）；
3. `apply(ctx, config)` 用 `ctx.effect` 注册：
   - `ctx.on('agent/created', async ({ agent }) => …)`（**serial、可 await**）：
     - 只要 `agent.parentAgent !== undefined`（子代理）→ **直接返回**；
     - `await loadFlow(...)` 得到结果，写进 `Map<Agent, CacheEntry>`；
     - `enabled: false` + `reason: 'missing'` → **什么都不注册**（连日志都只 debug 级）；
     - 否则 `agent.ctx.inject(['systemPrompt','tools'], scope => { … })` 里注册
       **段落**（`name: 'racing-code:flow'`, `order: 700`, `text: () => cache.get(agent)!.text`）
       与**工具** `flow_stages`；
   - `ctx.on('agent/disposed', …)`：dispose 那个 fiber（`catch` + `logger.warn`），删缓存；
   - `ctx.effect` 的清理函数里兜底 dispose 全部 fiber（会话结束、插件卸载各走一遍）；
   - `flow_stages`（`defineTool` + `scope.tools.register`）：参数 `{ stage?: string }`；
     每次调用**现读现算**（不复用缓存），返回 [architecture.md §8](architecture.md) 的结构；
     文件被删 → `{ ok:false, notEnabled:true }`；
   - watcher：启用时监听该文件；变更 → 标记过期 → **下一次组装**重新 `loadFlow` 并替换文本；
     重算失败 → 保留 last-known-good，只把诊断换新；
   - `ctx.logger.warn` 只在**配置类**问题（YAML/白名单/CR 复用）上打一次，避免每步刷屏。

**关键实现点**

- 段落 `text` 是**同步**的（`AssembleContext` 不含 cwd/session），所以项目根与缓存必须在
  `agent/created` 里用闭包钉死；
- 首次读取要在 `agent/created` 内 await 完成（该事件是 serial），否则第一个模型步可能没有段落；
  但仍要按"缓存未就绪就返回占位文本"写，别把正确性押在时序上；
- 段落文本**只读内存**，绝不做 I/O。

**验收**

- `Config.listConfigs { entry: "racing-code" }` 的 schema 是五个字段；`Tool.listTools` 在**没有流程文件**的
  会话里**没有** `flow_stages`，在**有流程文件**的会话里有；
- 本项目（有 `doc/racing-code.md`）新开会话 → 段落里出现**项目**那张图（含 `用户定稿?` 关口、两条赛道、
  汇合点 `cr`），`flow_stages` 返回 `entry: design`、`joins[0].at: cr`、`loops[]` 两条；
- 把文件改名 → 当前会话段落变成一句 `FLOW_FILE_MISSING_AFTER_ENABLE`，工具返回 `notEnabled`；
  新开会话 → 段落与工具**都不存在**；
- 把文件改坏（删一个箭头）→ 段落变成一句诊断、工具返回 `reason: 'invalid'` 带候选/错误码；会话照常发请求；
- 把 CR 的模型改成与 `implement-b` 相同 → 诊断里有 `FLOW_CR_MODEL_REUSED`；
- 某阶段路由不在白名单 → 段落与工具都标 `authorized: false`。

## M4. 端到端（中，必须新开会话）

**已经验过的（2026-10-17，本 profile）**：

| 检查 | 结果 |
|---|---|
| `install_bundle /home/liumenghan/dsh-racing-code` | ✅ `application: applied`，`warnings: []`，`enabled: true`，进入 profile 的 `dsh.profile.bundles` |
| `Config.listConfigs { name }` | ✅ 查到 `patchId: racing-code`；`status: unsupported`（预期，见 §M0 验收） |
| `Tool.listTools` | ✅ 出现 `flow_stages`（活跃会话的 `agents.list()` 安装路径生效） |
| **段落真的进了系统提示** | ✅ 会话日志 `system/message` 里含 `项目流程：/home/liumenghan/dsh-racing-code/doc/racing-code.md` + 紧凑图 + 路由 + 规则行；安装**前**那一条没有它 |
| **文件变更热刷新** | ✅ 同一条日志里最新一条 system prompt 已经是我改图**之后**的版本（含 `needs-code{要改代码吗?}`）——`fs.watch` → 重算 → 下一步生效，全程真实会话 |
| **`flow_stages` 真实读盘** | ✅ 在会话里直接调用：返回入口 `design`、6 个阶段、`[race: implement-a ∥ implement-b]`、3 条回边（评审轮最多 2 轮）、各阶段路由、`.worktrees/implement-a`（当时还是默认布局；现在本仓库用 `laneDir: branch`，赛道目录是 `racing/implement-a`）、全部阶段说明与渲染好的带模型 mermaid |
| **配置热生效 + "没声明就不启用"活路径** | ✅ 临时把该行 `projectFlowPath` 指向 `doc/racing-code.md.disabled` → 下一步的 `system/message` **不再含流程段落**、`request/header` 里 **`flow_stages` 消失**；还原补丁 → 工具**重新出现在请求头**（全程未重启、未新开会话）。探针已删除，profile 补丁已还原 |

**仍未实测的两条**（诚实记录，等第一次真跑赛道时确认）：

1. `agent/created` 的 await 语义：本次没有创建新会话，所以"首个模型步就带段落"没被实测；插件对两种时序都安全
   （缓存未就绪时下一步生效），已存在的会话靠 `ctx.agents.list()` 补装 ✅ 已实测；
2. **工具的作用域隔离**：单元测试断言它注册在 `agent.ctx` 上，官方 scope 文档说"通过 `agent.ctx` 注册的工具
   只对该 agent 可见"，但"子代理看不到 `flow_stages`"这条没有在真实子代理上验过。

**其余验收**（不需要新开会话的部分已经完成）：

- 未启用项目：换一个没有流程文件的项目开新会话 → `Tool.listTools` 里没有 `flow_stages`，
  系统提示里也没有流程段落（**活路径已按上表第 3 行验过**；单元测试覆盖同一路径：
  `test/host.test.mjs` 的 "a project without a flow file registers nothing at all"）。

**然后把插件当成真的编排者用一遍**（本仓库自己的流程：[doc/racing-code.md](racing-code.md)）：

在**本仓库**（两条赛道 + 设计定稿关口）跑一遍真实小任务，逐条勾：

1. **入口与段落**：段落首行是文件路径；图与 `doc/racing-code.md` 一致；`flow_stages` 的路由与图上标签一致；
2. **用户关口**：走到"用户定稿?"时它是**问你**（`ask_user_question`，选项就是那两条边的文字），
   不自己拍板；
3. **并行赛道**：两条 lane 在**同一条消息**里发起、都以后台方式运行；`git worktree list` 看得到
   `.worktrees/implement-a`、`.worktrees/implement-b`；两个子会话模型不同；主工作区**没被改动**；
   CR 在两条 lane **都 settle** 之后才开始；两条 lane 各自提交到自己的分支（`round 1:`）；
4. **复盘轮**：故意让 `implement-a` 留一个**它独有**的问题 →
   CR 判 A 未通过、B 通过；反馈用 `send_message` 发回 **A 原来的子代理**且**只含 A 自己的问题**；
   只有 A 被重跑（B 的 HEAD 与工作区没变）；修订在**同一 worktree/分支**完成并提交（`round 2:`）；
   CR 复评只看 A 的本轮新增 diff；**两条都通过的那一轮才出现胜者**；
5. **共同问题闭环**：构造"两条都错同一处"（例如契约没写清某个边界输入）→ CR 走**用户关口**问你是否完善约束；
   选"接受现状" → 该问题进已接受清单、下一轮不再当阻塞项；选"完善约束" → 回到 `design`；
6. **兜底与降级**：把 `maxReviewRounds` 临时设为 1 并构造"改完还是不通过" → 编排者**停下问用户**，
   不自己开第三轮；`send_message` 打到一个已结束的 `subagentId` → 退化为同模型新起一个并在汇报里说明；
7. **跨轮一致性**：`flow_stages` 的 `lane.worktree` / `lane.branch` 与磁盘上实际建出来的一致；
8. 未启用项目：换一个没有流程文件的项目开新会话 → 段落与 `flow_stages` 都不存在（`Tool.listTools` 里没有）。

赛道相关问题排查见 [compatibility.md](compatibility.md) §1.7（没有 cwd 参数、沙箱可写范围）与 §1.8
（`send_message` 的 continuable 语义）。

## M5. 文档回填（已完成，2026-10-17）

- ✅ README（中/英）：顶部"仅设计文档"→ **v0.1.0 已实现并装入 profile** + "最小上手"三步 + 目录改成实际结构
  + 文档索引标注"含真实会话实测证据"；
- ✅ [compatibility.md](compatibility.md) 新增 **§4 实测记录**：逐条列出真实会话里验过的六件事，
  以及**仍未实测**的三项（`agent/created` 的 await 语义、工具作用域隔离、赛道相关的一切）与原因；
- ✅ [development.md](development.md)：里程碑表加状态列；M4 表补实测证据；风险表 R1/R2 更新为"部分验证"；
- ✅ 规范漂移已回填：[workflow-format.md](workflow-format.md) 修正"渲染产物不参与解析"的错述、
  新增 `FLOW_ROUTE_MALFORMED` / `FLOW_BACK_EDGE_TARGET` 两个码、补"形状闭合后不能有多余文本"、
  [architecture.md](architecture.md) §4/§9 同步（无浏览器半、无 GUI 的理由）与 §7 紧凑图示例；
- ⏳ 未做（需要用户先拍板）：仓库**还不是 git 仓库**，所以流程里的"提交"目前只能做到收口
  （`doc/racing-code.md` 的 `### commit` 已写明这种情况怎么汇报）。
  （后已解决：`0785b3a` 起仓库按 worktree 容器布局成为 git 仓库。）

---

## M6–M8. 新项目引导（bootstrap，v0.2.0，2026-10-17）

设计与施工图见 [bootstrap.md](bootstrap.md)。**实测证据（本轮记录）**：

| 检查 | 结果 |
|---|---|
| 契约先行 | ✅ `30643ec`：工具 `racing_code_init`、`session` 哨兵、两关协议的契约 + 96 用例（**先红 25**） |
| 赛道 implement-a | ✅ `9549c0c`（`opencode-go/deepseek-v4.1-flash`）：96/96 全绿 |
| 赛道 implement-b | ✅ `512f85a`（`opencode-go/glm-5.3-flash`）→ 复盘轮 `2a4747c`：96/96 全绿 |
| CR round 1 | A 通过；B **1 条 blocking + 12 条共同问题** |
| 用户关口 `gate` | **完善约束** → 十二条钉死写进设计（`259c9cd`） |
| 用户关口 `confirm` | **发回修订** → B round 2（`2a4747c`）→ **CR round 2 通过** |
| 胜者 | **implement-b**（评分依据：十二条钉死全兑现；A 有 3 条后钉缺口），已 cherry-pick 进 main（`aaef55c` + `408877e`） |
| 落败分支 | `racing/implement-a` **保留**（worktree 不擅自删除），值得挑取 3 项：`loadCatalog` 按 provider 容错、每阶段说明非空断言、blocked 逐条报既有码 |
| e2e | ⏳ 三条**待真实新会话实测**：新会话看引导、init 后新会话启用、只读沙箱 dryRun 降级 |

**已接受/延后清单**（不再当阻塞项）：

- `buildPlan` 收到原始 catalog：plan 会夸报候选池数量（两条赛道同）；
- 空池原因文案、根级目标 parent 假 blocked、`generatedOn` 不查日历真实性；
- `generatedOn` 非法 / `cwd='/'` / `gitdir` 三条等 edge case 无直接测试用例；
- e2e 三条待真实新会话实测（同上）。

---

## M9–M11. 按声明分流（v0.2.0 之上的修订，2026-10-17）

**实测证据（本轮记录）**：

| 检查 | 结果 |
|---|---|
| 设计与契约 | ✅ `eb9a86b`/`e4905ba`/`208b845`/`c55d217`/`054cdce`：阶段按声明分流（没有按阶段命名的例外）、判定=带建议的用户关口、渲染两种标记（先红后绿） |
| 赛道 implement-a | ✅ `opencode-go/deepseek-v4.1-flash`：`dce5ce4`（round 1）→ `3ef6d93`（round 2）→ `51b347e`（round 3） |
| 赛道 implement-b | ✅ `opencode-go/glm-5.3-flash`：`57358cc`（round 1）→ `82736ef`（round 2）→ `4074640`（round 3） |
| CR | 三轮评审 + 用户两次判定（「A 通过」） |
| 胜者 | **implement-a**，按 `d86c5be`/`6b5d6ae`/`9f9ec78` 合入当前工作分支 `0.0.x`（**不直接落 `main`**），`npm test` **104/104 全绿** |
| 落败分支 | `racing/implement-b` **保留**（分支不删；落败 worktree 由收口清理） |
| e2e | ⏳ 仍**待真实新会话实测**（新会话看引导、init 后新会话启用、只读沙箱 dryRun 降级） |

**已接受/延后清单**（不再当阻塞项）：

- implement-b 的 `stage.id.startsWith('implement-')` 两处按阶段名分支（违背不变量，落选**未合入**）；
- lane 判定依赖 `buildLanes` 的实现细节；
- 模板 brief 为静态文本；
- 生成器与真实会话 e2e 三条仍待真实新会话实测。

---

## 测试策略

| 层 | 手段 | 说明 |
|---|---|---|
| 纯函数（解析/图校验/lane/回边/合并/渲染/诊断） | `node --test test/flow.test.mjs` | 无 DSH 依赖；**`doc/racing-code.md` 当夹具**防漂移 |
| 取源与启用判定 | 假 `fs` 对象 | 覆盖 `missing / unreadable / invalid / ok` 四条路径 |
| 宿主半注册 | 假 ctx 组装测试（照 [dsh-save-button/test/client-harness.mjs](</home/liumenghan/dsh-download-button/test/client-harness.mjs>) 的做法） | 断言：没文件时**只注册 `racing_code_init`**（`bootstrapEnabled: false` 时零注册）；有文件时 section + tool 各注册一次、参数正确、disposer 干净 |
| 守卫 | `test/package.test.mjs` | 禁止 `require` 官方实现包；断言 `package.json` **没有** `dsh.client` |
| 集成 | 装上去 + `cordis_inspect_query` + 新会话实测 | 见 M4；不使用也不假装官方集成测试框架 |

**不要**为了测试去 mock 官方模块的实现细节。

## 验证命令速查

```bash
node --check lib/index.js lib/flow.js lib/sources.js lib/bootstrap.js
node --test
node /home/liumenghan/deepseek-harness/apps/cli/lib/bin.js --profile web --dump-config | grep -A12 'racing-code'
```

```text
cordis_inspect_query  host    Config  listConfigs   { "name": "dsh-racing-code" }
cordis_inspect_query  host    Config  listConfigs   { "entry": "racing-code" }
cordis_inspect_query  host    Tool    listTools
plugin_manager        list_bundles / list_plugins
```

## 风险与依赖

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| R1 | `agent/created` 是否被 await（官方是 serial、可 await，但**本次没有新会话可验**） | 第一个模型步可能没有流程段落 | 已按"未就绪返回占位 + 下一步生效"写；`ctx.agents.list()` 补装路径**已实测**；新会话首次实测时确认一次 |
| R2 | 通过 `agent.ctx` 注册的工具**未必**只对该 agent 可见 | 没启用流程的项目里也会看到 `flow_stages` | 代码注册在 `agent.ctx`（§1.4 官方 scope 契约支持）；"没启用就完全没有工具"**已实测**（配置探针里它从 request header 消失）；"子代理看不到"待首次跑赛道确认 |
| R3 | 子代理会话的 cwd 是否等于父会话（工具没有 cwd 参数） | lane 的绝对路径策略失效 | 实现 M4.3 时实测一次 `git worktree list` 与子代理实际写入位置 |
| R4 | 白名单要手工加路由，用户容易漏 | 委派被官方工具拒绝 | 段落 + 工具明确给出"缺哪一条、加到哪里"；README/install 一节写清 |
| R5 | 沙箱 `read-only` 时建不了 worktree | 赛道开不起来 | 规程写明"申请一次提权或问用户"；插件不申请权限（它本来也不建 worktree） |
| R6 | 护栏（轮次/次数）只是提示词规则 | 模型可能不守 | M4.6 专门验收"超限停下问用户"；硬约束留给 v2 |
| R7 | 模型腐烂（`mimo-v2.6-flash` 流式被挡、`big-pickle` 下线、`kilo` 要特殊头） | 图上写的路由跑不通 | 缺路由兜底为当前会话模型；白名单校验提前标出；文档记录基准线 |
| R8 | 项目文件是唯一来源，写坏了就没流程 | 用户以为插件坏了 | 解析失败**必须**给诊断（M1 的底线测试 + M3 验收）；`flow_stages` 返回完整诊断 |
| R9 | mermaid 子集解析是手写的 | 边角输入误判 | 每个 error 码一个反例 + 真实文件夹具；解析规则以 [workflow-format.md](workflow-format.md) 为准，改规范必须同时改测试 |
| R10 | 模板三处同构漂移（`lib/bootstrap.js` 模板、[racing-code.md](racing-code.md)、README §5 示例） | 生成的流程与文档示例不一致 | 测试按"结构同构 + 0 error"断言、不做全文快照；改一处必须同步另两处 |
| R11 | 只读沙箱拒写（`FS_SANDBOX_DENIED` 等） | 引导落不了盘 | `BOOTSTRAP_WRITE_FAILED` + 全文返回，两级降级：申请提权 / 手动创建；只预览不受影响 |
| R12 | 生成器 bug 落盘半成品 | 项目拿到解析不了的流程文件 | 写前 `resolveFlow` 0-error 自校验（`BOOTSTRAP_TEMPLATE_INVALID` 拒写）；默认只预览 |
| R13 | 行为变化被当回归（升级后缺文件会话的工具表多了 `racing_code_init`） | 用户以为插件坏了/越权 | README §3/§5 明写 v0.2 变化 + `bootstrapEnabled: false` 逃生口 |

## 未决（实现时拍板）

1. `run_flow` 确定性执行器要不要做（v2；可架在 `ctx.workflowEngine` 之上，照 `tool-ralph` 的先例）；
2. 三个护栏要不要硬强制（要挂 `session/event` 数轮次，与"插件不参与请求路径"冲突）；
3. 流程文件名固定 `doc/racing-code.md`，还是支持候选链（如再找 `.dsh/racing-code.md`）；
4. CR 报告要不要提供"落盘到 `doc/cr/<日期>.md`"的选项；
5. 复盘轮要不要"逐赛道独立收敛"（通过的 lane 冻结）；
6. CR 的评分标准/权重要不要让项目在流程文件里声明。
