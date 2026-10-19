# dsh-racing-code：CR 人工意见入口 修改计划

> 日期：2026-10-20 ｜ 基线：`0.0.x` @ `9387418` ｜ 状态：**已定稿**（2026-10-20 用户过 final 关口，进入 contract-tests）
> 本文是计划文件（plan of record）。草稿与临时产物不进仓库，见同目录 `.gitignore`。

## 0. 用户已拍板

| # | 议题 | 决定 |
|---|---|---|
| 1 | 改动范围 | **本项目流程 + bootstrap `cr` brief + 测试**（保持"模板 / docs/racing-code.md / README"同构） |
| 2 | 入口位置 | CR 的每个用户关口（`common`/`gate`、`verdict`、`confirm`）都要显式邀请**人工 CR 意见**（自由文本，可留空） |
| 3 | 只写文字 | 有效回答：用户不选卡片、只写人工意见，也必须被处理，不得丢弃 |
| 4 | 有意见的 verdict | 不直接 `commit`：按"否：按反馈修订"走 `confirm`，即使同时选了"是" |
| 5 | 归属 | 人工意见按赛道切分；两条赛道的同类问题按共同问题走 `gate`；无法归属或与选项冲突时停下问清楚 |
| 6 | 图结构 | **不加新节点**：现有 `gate` / `verdict` / `confirm` 承载自由文本；选项是快捷方式，不是唯一输入 |

## 1. 目标与非目标

**目标**

1. CR 的每个用户关口都允许用户填写**人工 CR 意见**（自由文本）；提问里必须明说"也可直接填写人工 CR 意见（可留空）"。
2. 人工意见与 CR 自动生成的问题同等对待：按赛道切分、随 `confirm` 发回对应赛道；共同问题走 `gate`；无法归属就停下问。
3. `verdict` 只要收到人工意见，就不允许直接进 `commit`；先按"否：按反馈修订"处理。
4. 把这条规则写进本项目流程、bootstrap 的 `cr` brief、格式规范与两份 README，并用测试钉住 brief 的语义。
5. 不改变图结构、不新增诊断码、不改变 `ask_user_question` 的调用方式（它本来就返回 `selected` + `custom`）。

**非目标**

- 不加新的用户关口节点（`review` 之类）：入口挂在既有 CR 关口上，避免图多一次往返；
- 不改 `lib/flow.js`、不改 `ask_user_question` 的工具契约；
- 不改 CR 的评分/胜者规则（改动少者胜出仍然只在"都没有阻塞问题"时适用）；
- 不要求用户每次都填——人工意见可以留空，留空就按卡片选项走。

## 2. 现状与证据

| 事实 | 位置 |
|---|---|
| CR 的用户关口只写了"按出边文字选"，没有提自由文本 | [docs/racing-code.md](../racing-code.md) `### cr` 第 5/6/9 步；开头"非赛道节点都是用户关口"一段 |
| 全局规则把选项说成唯一输入 | "用 `ask_user_question` 让用户按出边文字选" |
| 生成模板的 `cr` brief 只有 3 条，没有人工意见入口 | [lib/bootstrap.js](../../lib/bootstrap.js) `BRIEFS.cr` |
| `ask_user_question` 本身返回 `{selected, custom}` | 本会话已多次验证：用户可只写 `custom` 文字 |
| 格式规范只写了"出边文字就是选项" | [workflow-format.md](../workflow-format.md) §8.1；§8.2 评审轮、§8.3 报告结构 |
| README 把用户关口描述成"选项" | [README.zh.md](../../README.zh.md) §2/§5；[README.md](../../README.md) §2/§5 |

一句话：工具支持自由文本，但流程从没要求编排者去邀请/读取它；于是 CR 关口退化成"只能点卡片"。

## 3. 设计

### 3.1 全局用户关口规则

在 [docs/racing-code.md](../racing-code.md) 开头的"非赛道节点都是用户关口"段补一句：

> 选项卡片只是**快捷方式**，不是唯一输入：每次提问都要允许用户填写**自由文本/人工意见**（CR 阶段尤其要显式邀请"人工 CR 意见"，可留空）；用户只写文字、不选卡片也算有效回答；文字必须被处理，不能丢弃；文字与选项冲突时停下问清楚，不自行合并。

### 3.2 `### cr` 小节

在现有第 4 步（追约束）之后插入新的第 5 步，并把后续步骤顺延：

> 5. **人工 CR 意见入口**：任何 CR 用户关口（`gate` / `verdict` / `confirm`）的提问里都明确写
>    "也可直接填写人工 CR 意见（可留空）"，并读取自由文本；用户只写文字不选卡片也算回答。
>    人工意见按赛道切分：
>    - 单赛道问题 → 随该赛道的问题在 `confirm` 后发回；
>    - 两条赛道的同类问题/约束缺口 → 按共同问题处理（仍走 `gate`，由用户选完善约束/接受现状）；
>    - 无法归属或与选项冲突 → 停下问清楚，不自行合并。

同时更新：

- `gate` 步骤：提问保留自由文本入口；用户写下的共同问题同样按 `gate` 的两个选项处理；
- `confirm` 步骤：提问保留自由文本入口；用户在 `confirm` 写下的人工意见，按赛道切分后与 CR 自动问题
  一起 `send_message` 发回；**不得丢弃，也不得未经确认就发**；
- `verdict` 步骤：提问保留自由文本入口；**用户只要写了人工 CR 意见，就按"否：按反馈修订"处理**
  （即使同时选了"是"），先走 `confirm`；只有"是"且没有人工意见才进 `commit`；
- 报告结构：CR 报告里单列"用户的人工 CR 意见（逐条）"，与自动问题分开。

### 3.3 bootstrap `cr` brief

在 `BRIEFS.cr` 增加第 4 条（仍满足"2–4 条可执行规则"）：

> `- CR 的每个用户关口都显式邀请**人工 CR 意见**（自由文本，可留空）：只写文字不选卡片也算回答；意见按赛道切分，verdict 写了意见就不直接提交。`

这条是**模板生成的 prompt 文案**；本项目自己的 `### cr` 小节（3.2）是同一规则的"接口"版本。

### 3.4 测试钉住（先红）

**`test/bootstrap.test.mjs`** 新增：

- `bootstrap_cr_brief_asks_for_manual_review_notes`：full 与 minimal 两个预设的 `cr` brief 都必须
  - 匹配 `/人工/`；
  - 匹配 `/自由文本/` 或 `/不选卡片/`；
  - 匹配 `/按赛道/\|/切分/`。

**`test/flow.test.mjs`** 在 "the repository flow file resolves cleanly…" 里加一条：

- 真实流程的 `cr.instruction` 必须匹配 `/人工 CR 意见/`（本项目的 `### cr` 就是 brief）。

红线：`BRIEFS.cr` 还没有这条文案，新用例失败；文档与测试本身先就位。

### 3.5 文档同步

| 文件 | 改什么 |
|---|---|
| `docs/racing-code.md` | 开头全局规则 + `### cr` 新第 5 步 + `gate`/`confirm`/`verdict` 措辞 + 报告结构 |
| `docs/workflow-format.md` | §8.1 用户关口允许自由文本；§8.2 评审轮的人工意见分诊；§8.3 报告含人工意见；§10 自查加一条 |
| `README.zh.md` / `README.md` | §2 "用户关口"行与 §5 `cr` 行补"可填写人工 CR 意见；有意见先按反馈处理" |
| `lib/bootstrap.js` | `BRIEFS.cr` 第 4 条（赛道实现） |
| `docs/plan/2026-10-20-manual-cr-notes.md` | 本文件 |

## 4. 契约（先红）要点

- 先写测试与文档（3.4/3.5），跑 `npm test`；
- 红：`bootstrap_cr_brief_asks_for_manual_review_notes` 失败（`cr` brief 还没有人工意见文案）；
- 本项目流程的 `cr.instruction` 断言在文档改完后应通过（它断言的是 `### cr` 小节）；
- 测试定稿后赛道不得修改 `test/`；契约本身有问题就回 `plan`。

## 5. 文件级改动清单

| 文件 | 动作 | 内容 |
|---|---|---|
| `docs/plan/2026-10-20-manual-cr-notes.md` | 新建 | 本计划 |
| `docs/racing-code.md` | 改 | 全局规则 + `### cr` 人工意见步骤 + 报告结构 |
| `docs/workflow-format.md` | 改 | §8.1/§8.2/§8.3/§10 |
| `README.zh.md` / `README.md` | 改 | §2/§5 的人工 CR 意见说明 |
| `test/bootstrap.test.mjs` | 改 | 新用例（full/minimal 的 `cr` brief 语义） |
| `test/flow.test.mjs` | 改 | 真实流程 `cr.instruction` 断言 |
| `lib/bootstrap.js` | 改（赛道） | `BRIEFS.cr` 第 4 条文案 |

## 6. 里程碑

1. **M1 计划定稿**：本文过 `final`；
2. **M2 契约（先红）+ 文档**：写两个测试用例与四处文档，`npm test` 红（`cr` brief 缺人工意见）；
3. **M2.5 `baseline` 关口**：提交基线（docs + tests），用户确认后开赛道；
4. **M3 赛道**：两条并行赛道只改 `lib/bootstrap.js` 的 `BRIEFS.cr` 文案，各自提交；
5. **M4 CR + 提交**：评审 → 按赛道发回 → 给胜者 → 合入 `0.0.x`。

## 7. 验收标准

- `cd 0.0.x && npm test` 全绿（151 + 新用例）；
- `flow_stages` 返回的 `cr` 说明包含"人工 CR 意见 / 自由文本 / 按赛道切分 / verdict 有意见不直接提交"；
- `renderBootstrapTemplate` 的 full 与 minimal `cr` brief 都包含这条规则（测试钉住）；
- 本轮 CR 实际可用：任一 CR 关口都能只写人工意见、不选卡片，且意见被按赛道处理（会话记录可验证）；
- 文档链接检查 0 missing。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 提示词文案无法像函数一样"先红后绿" | 用 brief 语义断言钉住（人工/自由文本/按赛道切分）；赛道只写文案，不改测试 |
| 人工意见与卡片选项冲突 | 规则要求停下问清楚；不自行合并 |
| 人工意见被当成"通过" | `verdict` 明确：有文字就按"否：按反馈修订"，不进 `commit` |
| 关口变成必填，拖慢流程 | 可留空；留空按卡片选项走 |
| 三处文案漂移（flow / 模板 / README） | 一次改齐；测试断言 full 与 minimal 的 brief |

## 9. 未决问题

无。若 `final` 关口用户要求把人工意见做成独立节点而不是挂在既有关口上，回 `plan` 改图。
