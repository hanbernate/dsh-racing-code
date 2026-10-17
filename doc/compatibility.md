# 兼容性与官方契约

本插件**不 import 任何官方实现**，只依赖下面这些**稳定的接缝**。每条都写明：依赖什么、在哪核实的、
失效时什么症状、怎么兜底。

实测环境：本机 DSH `0.2.0-rc.2`（source checkout `/home/liumenghan/deepseek-harness`），
profile `web`，`patchReload: live`，时间 2026-10-17。

---

## 1. Host 侧

### 1.1 插件行与配置（不再依赖设置表单）

- **依赖**：bundle 补丁插入一行 `racing-code`（`patchId` 就是我们自己的命名空间）；该行的 Config 决定
  `projectFlowPath` 与三个护栏默认值。**本插件不做 GUI**，所以字段**不需要** `.volatile()`。
- **Config 用 `~standard` schema（零依赖）**：`export const Config = { '~standard': { version: 1, vendor, validate } }`，
  `validate` 返回 `{ value: <已填默认值的配置> }` 或 `{ issues: [{ message, path }] }`；官方先例见
  `packages/boot/app-boot/tests/config-reload.spec.ts:236`（手写 `.mjs` 插件）。校验失败时 fibre 保留上一次配置。
- **`Config.listConfigs` 会把它报成 `status: "unsupported"`——这是预期的**：官方定义该状态为
  "its Config is not a native Schemastery graph"（`packages/extensions/tool-cordis/src/config.ts:16`），
  投影只认 Schemastery。`unsupported` **不等于**插件没跑：只要行不是 `inactive`，fiber 就在运行、
  `apply` 就拿到了配置。想引入 Schemastery 就必须 import 官方包，与零依赖约定冲突，所以选择保留 `unsupported`，
  改用**行为**验证配置生效（见 [development.md](development.md) M4 第 2 步）。
- **推论**：改这几个开关 = 改 profile 补丁里该行的 `config`（`patchReload: live`，不需要重启）；
  因为不投影表单，也就不存在 `SETTINGS_CONFLICT` 这类并发写入问题。
- **失效症状**：整行缺失 → 插件不加载（`list_bundles` 里没有它，或 `Config.listConfigs` 报 `inactive`）；
  写错字段类型 → `validate` 的 issue 会让该行的配置被拒、保留上一版配置（启动时则是默认值）。
- **兜底**：字段名保持与本页/README 一致；`patchId`（`racing-code`）不变。

### 1.2 系统提示段落

- **依赖**：`ctx.systemPrompt.section({ name, order, text })`；`text` 可以是每次组装时求值的函数；
  返回 disposer，须用 `ctx.effect` 挂上。
- **核实**：`packages/core/system-prompt/src/index.ts:53`（`PromptSection`，`text` 支持函数形式）、
  `:125`（`SECTION_ORDERS` 分配表）、`:454`（`section()` 注册；order 必须是有限数）。
- **本插件的取值**：`order: 700`（`TEAM_POLICY 600` 与 `PTC_ONLY 800` 之间）。外部贡献允许使用任意有限 order。
- **`text` 是同步的**：`string | ((context: AssembleContext) => string)`，
  **不能返回 Promise**（`packages/core/system-prompt/src/index.ts:66`）。而 `AssembleContext` 只有
  `scope` 与 `signal`，不含 cwd、不含 session——所以"按项目渲染"必须在注册时就把项目钉死（见 §1.6），
  文本本身只能读**内存缓存**，不能做 I/O。
- **失效症状**：段落不出现、位置跑到工具说明之后、或组装报错（组装失败会让整个会话发不出请求）。
- **兜底**：段落文本必须**永远可渲染**——项目没声明流程时**根本不注册段落**；声明了却解析失败时降级成
  一句诊断，而不是抛错、也不是空串。

### 1.3 委派工具的模型选择开关

- **依赖**：宿主设置 `subagent-model-selection-settings`（`enabled` + `allowedModels[{provider,model}]`）
  只决定"允许哪些路由"；**真正暴露 `provider`/`model` 字段的是委派工具行上的 `modelSelectionSettings: true`**。
- **核实**：`packages/subagent/tool-subagent/README.md`（"Set `modelSelectionSettings: true` to sample the Host's
  `subagent-model-selection` preference when each fresh top-level Session is composed"）；
  `packages/bundle/web-app/presets/{standard,ptc}.patch.yml` 里 `tool-subagent` 已带该开关（实测）。
- **采样时机**：新组合的**顶层会话**采样一次并记进会话，子会话继承；**已存在的会话不追溯**
  （"A restored Session without a recorded policy remains disabled"）。
- **失效症状**：`subagent` 工具没有 `provider`/`model` 字段、没有 `list_subagent_models` —— 先怀疑"这不是新会话"，
  再怀疑开关。
- **兜底**：任何改动后**新开一个会话**验证。

### 1.4 按 agent 注册提示段落（"按项目注入"的唯一可行形态）

- **依赖**：`agent.ctx.inject(['systemPrompt','tools'], scope => scope.systemPrompt.section({…}))`，
  配合 `ctx.on('agent/created', …)` 与 `ctx.on('agent/disposed', …)`。同一个段落 `name` 在不同 agent
  scope 里各注册一次是合法的（重复注册只在**同一** registry 里抛）。
- **核实**：官方先例 `packages/context/file-reference-local/src/index.ts:69-91`（`installPrompt` /
  `disposePrompt` / `agent/created` / `agent/disposed` / `ctx.agents.list()` 补装已存在的 agent）；
  事件表实测：`agent/created` 的 `mode` 是 **serial**，签名返回 `undefined | Promise<undefined>`，
  事件说明是"An entered agent is ready for per-agent initialization after factory setup"。
- **为什么必须这样**：§1.4 的 `AssembleContext` 拿不到 cwd，全局注册的段落无法知道"现在是哪个项目"，
  只能注册一次、渲染所有项目；按 agent 注册才能把该 agent 的 `cwd` 与缓存钉死在闭包里。
- **可等待性（关键）**：`agent/created` 是串行且可 await 的，所以**首次读文件可以在第一个模型步之前完成**。
  实现时仍需按"缓存未就绪就返回占位文本"写，别把正确性押在时序上（验收点见
  [development.md §4](development.md)）。
- **失效症状**：段落里显示的是别的项目的流程；或只对"事件之后创建的"会话生效、重启后已存在的会话没有段落。
- **兜底**：`ctx.agents.list()` 里补装一遍（官方先例同样这么做）；dispose 一律 `catch` + `logger.warn`，
  不让清理失败冒泡。

### 1.5 项目根 = 会话头里的 `cwd`

- **依赖**：`agent.session.header.cwd`（会话创建时的**绝对**工作目录，可能缺省）。
- **核实**：`packages/core/session/src/types.ts:104`（`readonly cwd?: string`，注释"Absolute working
  directory the session was created in"）、`:116-119`（构造时校验必须是绝对路径）；
  官方用法 `packages/context/file-reference-local/src/index.ts:122`（`agent.session.header.cwd ?? process.cwd()`）。
- **注意**：`ctx.workspaceRegistry` 是 GUI 的项目列表（有 id、标题、排序），**不是**"当前会话在哪个目录"；
  不要用它定位工作区。
- **失效症状**：`cwd` 缺省时若直接用相对路径，会以 dsh 进程的工作目录为基准，读到**别的项目**的文件。
- **兜底**：`cwd` 缺省 → 视为"没有项目流程"，直接用 L2/L3；绝不用 `process.cwd()` 顶替（那是 dsh 的启动目录）。

### 1.6 `ctx.fs` 读取与监听（不受沙箱模式限制）

- **依赖**：`ctx.fs.resolve(path, { cwd })` → `FsTarget`；`ctx.fs.readText(target)`；
  `ctx.fs.watch(target, changed, signal)`；`ctx.fs.stat(target)` 用于存在性判断。
- **核实**：服务目录 `fs`（抽象方法表）；`packages/fs/fs-local/README.md`（相对路径以 `config.cwd` 为基准，
  绝对路径不受限）、`packages/fs/fs-sandbox/README.md`（"Reads, listings, metadata, and read-only watches
  work exactly as with `fs-local`; the mutation fence does not restrict observation"）。
- **推论**：插件读项目里的流程文件**不需要请求提权**，`read-only` 会话里也能读到；反过来，
  本插件 v1 **不写任何工作区文件**（写才需要过沙箱）。
- **失效症状**：`FS_NOT_FOUND`（文件不在 → 插件不启用，这是正常路径）、`FS_NOT_TEXT`（二进制 → 当解析失败处理）。
- **兜底**：所有 `FsError` 按 `code` 分支（不要匹配 message 文本），并且**任何读取失败都只降级、不抛**。
  唯一的例外是"文件存在却读不出来"：那时要留一句 `FLOW_FILE_UNREADABLE` 诊断，而不是静默当没声明。

### 1.7 并行赛道：`subagent` 没有 cwd 参数，worktree 必须在项目根之下

- **依赖（事实）**：`subagent` 工具的参数表只有 `description` / `prompt` / `provider` / `model` /
  `reasoning_effort` / `run_in_background` —— **没有工作目录参数**
  （`packages/subagent/tool-subagent/src/index.ts:389-427`，实测 `Tool.listTools` 一致）。
  子代理继承委派者会话的 cwd（`subagent-acp` 的 README/源码明确写了这条继承规则；in-process 驱动同源）。
- **推论**：让"两个模型各写一版"落地，只能**物理隔离 + 提示词里写死绝对路径**：
  编排者 `git worktree add .worktrees/<lane-id> -b racing/<lane-id>`，然后在 lane 的提示词里声明
  "你的 worktree 是 `<绝对路径>`，所有 bash 用 `cd <worktree> && …`，文件工具用该目录下的绝对路径"。
- **为什么 worktree 必须在项目根之下**：`fs-sandbox` 的 `workspace-write` 只允许写
  **会话工作区（= 会话 cwd = 项目根）与平台临时根**（`packages/fs/fs-sandbox/README.md`：
  "permits targets only inside the session workspace or a platform temporary root"）。
  建在 `../` 会被 `FS_SANDBOX_DENIED`。子代理继承同一个 cwd，所以它的可写集合与父会话一致——
  worktree 在项目根下，lane 子代理才写得进去。
- **读写不对称**：读取不受栅栏限制，所以 CR 阶段**读**任意 worktree（甚至 `/tmp` 下的）都没问题；
  受限的只有写。
- **`read-only` 会话**：`git worktree add` 会写 `.git/worktrees/*` 与工作目录 → 直接 `[sandbox: file access
  denied under read-only mode]`；这是策略拒绝，**不要绕**，让编排者按提示申请一次提权，或问用户。
- **DSH 没有原生 worktree 支持**：`grep -rli worktree packages apps` 无相关特性；这一层完全由编排者
  用普通 bash + `subagent` 组合出来。
- **失效症状**：lane 子代理"改了但主工作区没变"（它在自己的会话 cwd 里写了）／两个 lane 互相覆盖
  （worktree 没建成，掉回同一个目录）／CR 读不到产物（路径写错）。排查顺序：worktree 是否真的建了
  （`git worktree list`）、提示词里的绝对路径是否与 `.worktrees/<lane-id>` 一致。

### 1.8 把 CR 的反馈发回**同一条赛道**：continuable 子代理 + `send_message`

- **依赖**：这个 profile 里的委派工具是 **continuable** 形态——后台跑完后返回
  `{ kind: 'continuable', subagentId }`，此后可以用 `send_message` 继续**同一个**子代理
  （工具说明："A working agent receives it at its next step; an idle agent starts a new turn with it"）。
- **核实**：实测 `Tool.listTools` 的 `subagent` 输出 schema 是 `oneOf: [background(jobId),
  continuable(subagentId), …]`，且描述里写明"returns a subagent id you can continue with
  `send_message`"；配套还有 `list_agents` / `interrupt_agent` 做记账与打断。
- **为什么必须用它**：复盘轮要"由赛道模型修改"——同一个子代理还记得自己为什么这么写、上一轮踩过什么；
  换成"新子代理 + 把 diff 塞进提示词"会让它重新猜，评审轮次越多偏差越大。
- **退化路径**：子代理已不可续（会话被清理、进程重启）时，退化为"同 provider/model 新起一个"，
  提示词里带上**它自己的 diff**、上一轮反馈与本轮验收命令，并在汇报里说明发生了退化。
- **独立性要求**：发给某条 lane 的消息里**只包含它自己的问题**，不含另一条 lane 的问题与评分对比
  （否则下一轮就不再是独立作答，横向比较失效）。
- **失效症状**：`send_message` 报目标不可用；或赛道在修订轮里"突然开始模仿另一条赛道"（说明反馈串了）。
- **兜底**：任何情况下都**不**让 CR 直接改赛道代码——评审与实现同一只手，比较就失去意义。

### 1.9 `ctx.get('llm')`：llm 目录（bootstrap 模型选项卡的候选来源）

- **依赖**：`llm` 服务的 `listProviders(): LlmProviderInfo[]`（同步）与 `await listModels(providerId): LlmModelInfo[]`
  （`LlmModelInfo = { provider, id, name, description? }`）。`racing_code_init` 的候选池 = 子代理白名单 ∩ 该目录。 **字段契约**（CR 复评补）：`listProviders(): {id: string}[]`（同步）、`listModels(providerId): Promise<{id: string, description?: string}[]>`；映射为 `{provider: id, model: model.id, note: description?}`。字段不符时防御式降级为空池 + warn（不崩）。
- **核实**：CR 阶段在 /home/liumenghan/deepseek-harness 实证（`packages/llm` 的 api-catalog 与 types）；
  本机目录由 profile 的 `llm-pi-ai` providers 配置提供（opencode-go / kilo）。
- **降级**：`ctx.get('llm')` 不可用或字段缺失 → 候选为空 + `BOOTSTRAP_NO_CANDIDATES`（选项卡只剩"用会话模型"）；
  白名单服务不可用（`allowedModels === null`）→ 跳过校验、候选 = 全目录。
- **失效症状**：选项卡空，或列出了白名单里有、上游却已下线的路由（目录本身也会腐烂，见 §2）。

## 2. 上游模型（不是 DSH 契约，但同样会"漂"）

2026-10-17 用真实调用实测过的一轮，记在这里当基准线。**"目录里有"不等于"能用"**——
下面每一行都是先看目录、再发真实请求（并且区分**流式**与**非流式**）得到的结论：

| 路由 | 非流式 | 流式（DSH 唯一走法） | 结论 |
|---|---|---|---|
| `opencode-go` · `mimo-v2.6-pro` | 200 | 200 | ✅ 可用 |
| `opencode-go` · `glm-5.3-flash` | 200 | 200 | ✅ 可用（接口+测试阶段默认） |
| `opencode-go` · `deepseek-v4.1-flash` | 200 | 200 | ✅ 可用 |
| `opencode-go` · `mimo-v2.6-flash` | 200 | **400 `[model_coming_soon]`** | ❌ 现在不可用；留作备胎 |
| `opencode-go` · `big-pickle` | **400 `Model is unavailable`** | — | ❌ 上游已下线；免费端点 `zen/v1` 又拒绝非 OpenCode 客户端 |
| `kilo` · `kilo-auto/free` | 200 | 200 | ✅ 可用，但需要 §3.2 的两个静态头 |

### 2.1 `mimo-v2.6-flash`：流式被上游挡在"即将上线"

同一个模型、同一个 key、同一个端点：

```
{..., "max_tokens": 4}                    → 200
{..., "max_tokens": 32768, "stream":true} → 400 [model_coming_soon]
{..., "stream":true}                      → 400 [model_coming_soon]
{..., "reasoning_effort":"max"}           → 200
{..., "tools":[...]}                      → 200
```

DSH 只走流式，所以这条路由**在配置层面无解**，只能换模型或等上游。排查手法：把失败子会话的
`session.v4.jsonl.zstd` 解出来看 `failure.message`，再拿同样形状的请求打一次上游。

### 2.2 `kilo`：免费档认 `x-api-key`，不认 bearer

| 请求头 | 结果 |
|---|---|
| 无 `Authorization` | 200 |
| `Authorization: Bearer FREE` | 401 `INVALID_TOKEN` |
| `Authorization: Bearer`（空 token） | 200 |
| `x-api-key: FREE` | 200 |
| `Authorization: Bearer FREE` + `x-api-key: FREE` | 401（bearer 优先，所以不能带真 bearer） |

而 pi-ai 的 `openai-completions` 客户端**不允许完全没有凭据**：

```js
// pi-ai dist/api/openai-completions.js
function getClientApiKey(provider, apiKey, headers) {
  if (apiKey) return apiKey;
  if (hasHeader(headers, 'authorization') || hasHeader(headers, 'cf-aig-authorization')) return 'unused';
  throw new Error(`No API key for provider: ${provider}`)   // ← 只配 keyless 时就是这里炸的
}
```

同时 SDK 的 header 合并顺序是 `[平台头, authHeaders(Bearer <apiKey>), defaultHeaders, bodyHeaders, options.headers]`，
而 pi-ai 把配置里的 `headers` 合到最后（`openai-completions.js`：`Object.assign(headers, optionsHeaders)` →
`defaultHeaders`），所以**配置里的 `authorization` 会覆盖 SDK 自己发的 `Bearer unused`**。

于是这条路由的可用形态是：

```yaml
kilo:
  api: openai-completions
  baseURL: https://api.kilo.ai/api/gateway
  headers:
    x-api-key: FREE          # 网关真正读的凭据
    authorization: Bearer    # 只为通过 pi-ai 的客户端检查，且会覆盖 SDK 的 Bearer unused
```

拿到真实 Kilo key 后，删掉这两个头、改回 `apiKeyEnv: KILO_API_KEY` 即可。

### 2.3 怎么快速验一条路由（不必新开会话）

`workflow` 工具的 `agent(prompt, { provider, model })` 把 provider/model **直接透传给子代理 provider**
（`dsh-workflow-ptc/src/host.ts` 的 `startAgent` → `agentOptions`），因此**绕过** `subagent-model-selection`
白名单，可以在当前会话里就地把任意路由打一发真实请求：

```js
// workflow 脚本体
phase('probe')
const text = await agent('Reply with exactly this text and nothing else: OK', {
  label: 'route probe', phase: 'probe', provider: 'kilo', model: 'kilo-auto/free',
})
return { ok: text !== null, reply: text === null ? null : String(text).trim().slice(0, 40) }
```

失败时 `agent()` 返回 `null`，真正的原因在**子会话**的 `session.v4.jsonl.zstd` 里
（`zstdcat <file> | grep -o '"failure":{[^}]*}'`）。

### 2.4 结论

**模型清单会腐烂，而且会以三种不同方式腐烂**：下线（`big-pickle`）、未开放流式（`mimo-v2.6-flash`）、
需要特殊鉴权头（`kilo`）。所以：

- 页面下拉以**实时目录**为准，并允许手工填路由；
- 已存但目录里没有的路由标"不可用"，而不是隐藏；
- 真正决定"能不能用"的是委派那一刻的返回值，文档只能保证"我们记录过一次实测"。

## 3. 装/改/重启的边界

| 操作 | 是否需要重启 | 依据 |
|---|---|---|
| 首次安装本 bundle | 通常可 HMR 激活 | `references/host-plugin.md` |
| 改本插件自己的 `lib/*.js`（同包替换） | **需要重启** dsh 才能加载新的 JS 模块代 | 同上 |
| 改 profile 补丁里的 `racing-code` 配置 | 不需要（`patchReload: live`） | profile `package.json` 的 `dsh.profile.patchReload` |
| 改**项目的** `doc/racing-code.md`（图或模型） | 不需要，**下一个模型步**生效 | §1.6 的 `fs.watch` → 缓存失效 → 逐模型步组装 |
| **新建** `doc/racing-code.md`（项目从"未启用"变"启用"） | 对已有会话**不生效**，需新开会话 | 段落与工具注册在 agent scope 上，启用状态在 `agent/created` 时判定 |
| **删除** `doc/racing-code.md` | 当前会话退化为一句诊断；新会话完全不启用 | 同上；last-known-good 对"删除"不适用 |
| 改子代理**白名单**并希望已有会话生效 | 做不到，需新开会话 | §1.3 采样时机 |
| 建 lane 的 worktree（`git worktree add`） | 不需要重启；但**需要会话沙箱允许写项目根** | §1.7（`workspace-write` 覆盖会话工作区；`read-only` 下会被拒，需提权或问用户） |
| 装完插件后**什么都不配** | **不生效**：没有全局流程，也没有兜底流程 | 插件只在声明了流程图的项目里启用，见 [workflow-format.md](workflow-format.md) §1.1 |

## 4. v0.1.0 实测记录（2026-10-17）

插件装进本机 `web` profile 后，在**一个真实会话**里逐条验过的（不是"应该会"）：

| 结论 | 证据 |
|---|---|
| 手写 `~standard` Config 被 Loader 接受、`apply` 拿到配置 | `Config.listConfigs` 报 `status: unsupported`（预期值，见 §1.1）而**不是** `inactive`；改 `projectFlowPath` 后行为随之改变 |
| 按 agent 注册的**段落真的进了系统提示** | 本会话 `session.v4.jsonl.zstd` 的 `system/message` 记录里含 `项目流程：<绝对路径>` + 紧凑图 + 路由 + 规则行；**安装前**那条记录没有它 |
| 按 agent 注册的**工具真的进了请求头** | 同一日志的 `request/header` 记录里出现 `flow_stages`（并能被模型直接调用，返回真实读盘结果） |
| 改项目流程图 → **下一步生效** | 改图后最新一条 `system/message` 已是新版图（含新加的 `needs-code{要改代码吗?}`） |
| 改 profile 配置 → **热生效**（不用重启、不用新会话） | 把 `projectFlowPath` 指向不存在的路径后：最新 `system/message` **不再含流程段落**、`request/header` 里 **`flow_stages` 消失**；还原后两者都回来 |
| 活跃会话的**补装路径** | 插件是在会话进行中安装的，靠 `ctx.agents.list()` 立刻对本会话生效 |

**仍未实测（诚实记录）**：

| 项 | 为什么没验 | 风险与现状 |
|---|---|---|
| `agent/created` 的 await 语义（首个模型步是否已带段落） | 本次没有创建新会话 | 插件对该时序不敏感：缓存未就绪时返回占位、下一步生效；`agents.list()` 补装已实测 |
| 工具的作用域隔离（子代理是否看不到 `flow_stages`） | 没跑赛道（用户选择先不跑） | 代码注册在 `agent.ctx` 上、§1.4 的官方 scope 契约支持该行为；首次真跑赛道时确认 |
| 赛道相关的一切（worktree、`send_message` 复盘轮、CR 共同问题） | 同上 | 规程与提示词模板已在 [workflow-format.md](workflow-format.md) §5/§8/§11 定稿；`git worktree` 与 `send_message` 的官方契约见 §1.7/§1.8 |
