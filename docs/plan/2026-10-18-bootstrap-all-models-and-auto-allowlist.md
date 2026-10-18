# dsh-racing-code：bootstrap 候选全量 + 选中自动加白 修改计划

> 日期：2026-10-18 ｜ 基线：`0.0.x` @ `badf11c` ｜ 状态：**已定稿**（2026-10-18 用户过 `final` 关口，进入 `contract-tests`）
> 本文是计划文件（plan of record）。草稿与临时产物不进仓库，见同目录 `.gitignore`。

## 0. 用户已拍板

| # | 议题 | 决定 |
|---|---|---|
| 1 | 第 2 次介入（逐节点选模型）的候选池 | **DSH llm 目录全量**（所有 provider × 其广告模型），不再与子代理白名单求交 |
| 2 | 未授权候选的呈现 | 选项卡**标注**：不在白名单里的写"未授权（选中后自动加入白名单）" |
| 3 | 选中之后的动作 | **自动加白**：把选中的、不在 `allowedModels` 里的路由**追加**进 `subagent-model-selection-settings` |
| 4 | 流程文件里的模型（上一轮选定） | **运行时解析（DSH 为准）**：文档不再冻结 provider/model —— 见 §5 |
| 5 | 候选排序 | **目录原序**（provider 顺序 → model 顺序），不重排、不"已授权优先" |
| 6 | §5 的分配规则 | **稳定顺序**：按阶段声明顺序，取池里第一个未被占用的路由 |
| 7 | §5 是否同轮 | **一起做**：§3 与 §5 同轮开赛道 |

## 1. 目标与非目标

**目标**

1. `racing_code_init` 的第 2 次介入，候选 = DSH 的 llm 目录全量；`qwen3.8-flash` 这类"目录里有、白名单里没有"的模型必须出现且可选。
2. 用户选中未授权路由后，工具把它追加进 DSH 白名单：**幂等、只追加、不删除、不重排**，并在输出里报明"加了什么、新会话才生效"。
3. 两关语义不变：预览（`write:false`）零副作用；只有 `write:true` 且全部前置校验通过后才动白名单与流程文件。
4. 白名单写入失败**不静默**：降级为 warn + 可直接粘贴的 yml 片段，流程文件照常落盘。

**非目标**

- 不改 DSH 自身、不 fork `@deepseek-ai/dsh-tool-subagent`、不碰其它插件；
- 不做设置页 GUI；不删除、不重排用户已有的白名单条目；
- 不在预览阶段写任何东西；不在会话初始化时自动加白（自动写入只由用户的显式选择触发，见 §5）。

## 2. 现状与证据

| 事实 | 位置 |
|---|---|
| DSH 的 llm 目录（provider × 广告模型） | `~/.dsh/profiles/web/cordis.patch.yml` → `llm-pi-ai.providers.*.models`；`opencode-go` 有 6 个（含 `qwen3.8-flash`） |
| 子代理白名单 | 同文件 `subagent-model-selection-settings.config.allowedModels`，当前 5 条，**无 qwen** |
| 候选池 = 目录 ∩ 白名单 | [lib/index.js](../lib/index.js) `loadCatalog()` × `allowedModels()`；[lib/bootstrap.js](../lib/bootstrap.js) `buildRouteChoices()`（`pool = (catalog ?? []).filter(... allowed.some(...))`） |
| 非白名单路由在委派时被拒 | `packages/subagent/tool-subagent/src/model-selection.ts:139` `assertAllowedModelSelection()` |
| 白名单的服务与写入口 | 服务 `subagentModelSelection`（`current()` → `{enabled, allowedModels}`）；写入口 `ctx.get('settings').describe()/update(ns, patch, revision)`，ns = `subagent-model-selection-settings`（`packages/settings/settings/src/index.ts:347`） |
| 路由策略在**会话组装时**快照 | `packages/subagent/tool-subagent/src/index.ts:413-441`（`freshSession` 时读 `settings.current()`）→ 加白要**新会话**才生效 |
| 白名单关闭时策略为 undefined | 同上 `:434`（`current.enabled ? current.allowedModels : undefined`）→ 关闭时显式路由不经白名单校验，**不需要加白** |

一句话：候选"像写死的名单"是因为它与白名单求交；而白名单本身是 DSH 里一份**可写**的设置。

## 3. 设计 A：候选池全量 + 选中自动加白

### 3.1 纯层（`lib/bootstrap.js`）

- `buildRouteChoices({catalog, allowedModels, allowlistWritable, stages, lanes})`：候选池从 `目录 ∩ 白名单` 改为 **`目录` 全量**；每条候选新增：
  - `authorized: boolean` —— 该路由在不在白名单里；
  - `willAllowlist: boolean` —— `!authorized && allowlistWritable`。
- `allowedModels === null`（服务不可用）：全部 `authorized: true`、`willAllowlist: false`，并追加 note `BOOTSTRAP_ALLOWLIST_UNAVAILABLE`。
- `allowedModels: []`（白名单为空）：全部 `authorized: false`、`willAllowlist: true`。
- `BOOTSTRAP_NO_CANDIDATES` 的触发条件收紧为 **`catalog` 为 null 或空**（不再由"白名单为空 / 无交集"触发）。
- 新增 note `BOOTSTRAP_ALLOWLIST_WILL_ADD`：把"未授权项会被追加"讲给编排者。
- `choiceLines()`（宿主层渲染）逐条输出：`provider/model — 名称｜已授权` 或 `provider/model — 名称｜未授权（选中后自动加入白名单）`。

### 3.2 宿主层（`lib/index.js`）

新增 `allowlistWriter(ctx)`，两个方法：

- `read()`：
  - `ctx.get('subagentModelSelection')` 缺失 → `{status:'unavailable'}`；
  - `current().enabled === false` → `{status:'disabled'}`；
  - 否则 `{status:'ok', allowedModels}`。
- `add(routes)`：
  - `disabled` / `unavailable` → 原样返回（调用方转成诊断）；
  - `missing = routes − allowedModels`（按 `provider\0model` 去重，保持传入顺序）；空 → `{status:'noop'}`；
  - `ctx.get('settings')` 缺失 → `{status:'unavailable'}`；
  - `settings.describe()` 里找 `ns === 'subagent-model-selection-settings'` 的 `revision`；找不到 → `unavailable`；
  - `await settings.update(ns, { allowedModels: [...allowedModels, ...missing] }, revision)`；
  - `SettingsConflictError`（`SETTINGS_CONFLICT`）→ 重读并重试**一次**；仍冲突 → `{status:'conflict'}`；
  - 其它异常 → `{status:'failed', message}`；成功 → `{status:'added', routes: missing}`。

`racing_code_init` 的 `write:true` 顺序（关键）：

1. 现有前置校验全部走完（`BOOTSTRAP_PLAN_BLOCKED` / `BOOTSTRAP_CHOICE_REQUIRED` / `BOOTSTRAP_FILE_EXISTS`）——**任一不通过就直接返回，一个字节都不写**；
2. 收集用户选中的、非 `session` 的路由 → `allowlistWriter.add(...)`；
3. 写流程文件（现有 `createIfAbsent` / `replaceIfVersion` + 会话沙箱策略）；
4. 诊断按状态追加：`BOOTSTRAP_ALLOWLIST_ADDED`(info) / `BOOTSTRAP_ALLOWLIST_NOOP`(info) / `BOOTSTRAP_ALLOWLIST_DISABLED`(info) / `BOOTSTRAP_ALLOWLIST_UNAVAILABLE`(warn) / `BOOTSTRAP_ALLOWLIST_WRITE_FAILED`(warn) / `BOOTSTRAP_ALLOWLIST_CONFLICT`(warn，附 yml 片段)；
5. 最后仍是 `BOOTSTRAP_RESTART_REQUIRED`（白名单与会话路由策略都要新会话才生效，正好同一句话覆盖）。

`bootstrapProtocol()` 第 7 步补一句：候选来自 DSH 的 llm 目录全量；不在白名单里的会标注，**选中后由工具追加进白名单**（新会话生效）。

### 3.3 不变量改写（文档必须同步）

- `architecture.md` §10、`compatibility.md` §1.6、`bootstrap.md` §1 的表格：由"**唯一的写** = 用户两次确认后写项目流程文件"改为
  "**两处写** = ① 项目流程文件；② DSH 的子代理白名单（`subagent-model-selection-settings.allowedModels`）——只在用户于选项卡上显式选中未授权路由时**追加**，不删不改不排序"。
- 插件对 DSH 的依赖从"只读"变为"读 + 一处窄写"；`settings` 服务仍是**可选**依赖（不进 `inject`），缺席时降级为提示。

## 4. 契约（先红）要点

**纯层（`test/bootstrap.test.mjs`）**

- 候选 = 目录全量：白名单外的模型也出现，且 `authorized: false`、`willAllowlist: true`；
- 白名单内的模型 `authorized: true`、`willAllowlist: false`；
- `allowedModels: null` → 全部 `authorized: true` + `BOOTSTRAP_ALLOWLIST_UNAVAILABLE`；
- `catalog` 为空 → `BOOTSTRAP_NO_CANDIDATES`；白名单为空但目录非空 → **不报** `BOOTSTRAP_NO_CANDIDATES`；
- tab 文案含"未授权（选中后自动加入白名单）"；
- 旧用例 `bootstrap_candidates_intersect_allowlist_and_catalog` 改名/改断言（不再求交）。

**宿主层（`test/host.test.mjs`，fake `settings` + fake `subagentModelSelection`）**

- 选中未授权路由 → `settings.update` 收到"原数组 + 追加项"，`expectedRevision` = describe 的 revision；
- 幂等：路由已在白名单 → 不调用 `settings.update`（`NOOP`）；
- `SETTINGS_CONFLICT` → 重读重试一次；连续冲突 → `BOOTSTRAP_ALLOWLIST_CONFLICT` 且**流程文件照样写**；
- `settings` 服务缺失 → `BOOTSTRAP_ALLOWLIST_UNAVAILABLE`，流程文件照样写；
- `enabled: false` → 不调用 `settings.update`，`BOOTSTRAP_ALLOWLIST_DISABLED`；
- 预览（`write:false`）、拒写路径（plan blocked / 赛道未选齐 / 文件已存在且无 force）→ **一次都不调用** `settings.update`；
- `inject` 仍是 `['agents','fs']`（`settings` 不进硬依赖）。

## 5. 设计 B：运行时解析（已定稿：稳定顺序，与 §3 同轮）

- 新增 front-matter 哨兵 **`auto`**：该阶段**委派**，路由在会话初始化时从 DSH 解析。四种写法并列：

  | 写法 | 赛道阶段 | 非赛道阶段 |
  |---|---|---|
  | `provider/model` | 委派，用该路由（不在池里 → 见下） | 同左 |
  | `auto` | 委派，运行时分配 | 委派，运行时分配 |
  | `session` | 委派，继承会话模型 | **在当前会话直接执行** |
  | 缺键 | 委派，运行时分配（等价 `auto`） | 在当前会话直接执行 |

- 池 = **目录 ∩ 白名单**，**目录原序**（provider 顺序 → model 顺序）去重；**不自动加白**（自动写入只由用户在选项卡上的显式选择触发，见 §3）。
- 分配（**稳定顺序**）：按阶段**声明顺序**（`buildFlow` 的 stages 顺序），每个待分配阶段取池里**第一个未被占用**的路由 → `routeSource: 'runtime'`、`fallback: false`、`authorized: true`；池耗尽 → `FLOW_ROUTE_UNRESOLVED`（warn）+ 退回会话模型（`fallback: true`）。
- 声明了 `provider/model` 的阶段：命中池则沿用（并占用该池位）；不在池里 → `FLOW_ROUTE_UNAVAILABLE`（warn），随后按 `auto` 参与运行时分配（保留"该阶段委派"的意图，模型腐烂可自愈）。
- 池不可用（`llm` 服务缺席）→ **完全跳过**运行时解析，退回今天的行为（赛道缺键仍是 `FLOW_ROUTE_MISSING`）。
- `mergeRoutes` 增第 4 参 `{ runtimeAvailable }`：赛道阶段缺键且池可用时不再报 `FLOW_ROUTE_MISSING`，记为 `routeSource: 'auto'`。
- 刷新：`llm/adapters-updated` 事件（DSH 自家插件同款写法）触发重解析；`flow_stages` 每次调用现读现算，池变化最多在下一问生效。
- `routeSource` 联合类型增 `'auto' | 'runtime'`；policy section 与 `flow_stages` 把运行时解析出来的路由标注出来。

## 6. 文件级改动清单（§3 部分）

| 文件 | 动作 | 内容 |
|---|---|---|
| `lib/bootstrap.js` | 改 | `buildRouteChoices` 池改全量 + `authorized`/`willAllowlist`；`BOOTSTRAP_NO_CANDIDATES` 条件；`BOOTSTRAP_ALLOWLIST_WILL_ADD`；`bootstrapProtocol` 第 7 步文案 |
| `lib/index.js` | 改 | `allowlistWriter()`；`racingCodeInitTool` 注入它并落实 `write:true` 顺序；`choiceLines` 文案；新诊断码；`loadCatalog` 保持（已返回全量目录） |
| `test/bootstrap.test.mjs` | 改 | §4 纯层用例（先红） |
| `test/host.test.mjs` | 改 | §4 宿主用例（先红） |
| `docs/architecture.md`、`docs/compatibility.md`、`docs/bootstrap.md` | 改 | §3.3 不变量改写 + 新诊断码 |
| `docs/workflow-format.md` | 改 | §9 诊断码分组补 `BOOTSTRAP_ALLOWLIST_*` |
| `README.zh.md` / `README.md` | 改 | 引导章节：候选来自 DSH 目录全量、未授权项选中后自动加白、新会话生效 |
| `locale/zh.json`、`locale/en.json` | 改 | 卡片描述补一句"未授权模型选中后自动加白" |

（§5 已定同轮做，另加 `lib/flow.js`、`lib/sources.js`、`test/flow.test.mjs`、`test/sources.test.mjs` 与对应文档。）

## 7. 里程碑

1. **M1 计划定稿**：本文过 `final` 关口；
2. **M2 契约（先红）**：`test/bootstrap.test.mjs` + `test/host.test.mjs` + `test/flow.test.mjs` + `test/sources.test.mjs` 新用例，`npm test` 红且红的理由与"还没实现"一致；
3. **M3 赛道**：两条并行赛道（不同模型），只改 `lib/`，各自提交；
4. **M4 CR + 提交**：评审 → 按赛道发回 → 给胜者 → 合入 `0.0.x` → 回填文档。

## 8. 验收标准

- `cd 0.0.x && npm test` 全绿；
- 真实会话里 `racing_code_init` 的候选包含 `opencode-go/qwen3.8-flash`，且标"未授权（选中后自动加入白名单）"；
- 选 qwen 后 `write:true`：`~/.dsh/profiles/web/cordis.patch.yml` 的 `allowedModels` 出现 `opencode-go/qwen3.8-flash`（只追加、其余条目与顺序不变），流程文件同时落盘，输出含 `BOOTSTRAP_ALLOWLIST_ADDED` 与 `BOOTSTRAP_RESTART_REQUIRED`；
- 重复执行 → `BOOTSTRAP_ALLOWLIST_NOOP`，白名单不再变化；
- 预览与拒写路径零副作用（白名单文件 mtime / `git diff` 可验证）；
- 新会话里 `list_subagent_models` 能列出新加的路由，且 `flow_stages` 的路由行指向它。

## 9. 风险

| 风险 | 缓解 |
|---|---|
| 写 DSH 设置是新的副作用面 | 只在 `write:true` 后、只追加、revision 栅栏、失败降级为提示 + yml 片段；预览/拒写零副作用 |
| `settings` 服务在别的 profile / 无头环境缺席 | 可选依赖 + `BOOTSTRAP_ALLOWLIST_UNAVAILABLE`，流程文件照写 |
| 白名单里累积"僵尸"路由（模型下线） | 插件不删；由设置页清理；§5 的 `FLOW_ROUTE_UNAVAILABLE` 负责在会话期暴露 |
| 候选变长（目录全量） | tab 按 provider 分组；排序固定为目录原序（§10 已决） |
| 会话内加白不生效 | 已有 `BOOTSTRAP_RESTART_REQUIRED` 覆盖（会话路由策略在组装时快照，证据见 §2） |

## 10. 未决问题（2026-10-18 已决）

| # | 问题 | 决定 |
|---|---|---|
| 1 | 候选排序 | **目录原序**（provider 顺序 → model 顺序），不重排、不"已授权优先" |
| 2 | §5 的分配规则 | **稳定顺序**：按阶段声明顺序取池里第一个未被占用的路由 |
| 3 | §5 是否同轮 | **一起做**：§3 与 §5 同轮开赛道 |
