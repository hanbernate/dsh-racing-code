# dsh-racing-code：命名与「按项目配置」修改计划

> 日期：2026-10-18 ｜ 基线：`0.0.x` ｜ 状态：已定稿，待实施
> 本文是计划文件（plan of record）。草稿与临时产物不进仓库，见同目录 `.gitignore`。

## 0. 用户已拍板

| # | 议题 | 决定 |
|---|---|---|
| 1 | 赛道名前缀形态 | **方案 B**：分支与目录 = `<workBranch>-racing/<lane-id>`（例 `0.0.x-racing/implement-a`）。目录 = 分支名，与工作分支目录同级，无嵌套 |
| 2 | 配置存放 | **方案 A**：新增项目内 `.dsh/racing-code.yml`；全局 patch 不再固定 `projectFlowPath` |
| 3 | `doc`→`docs`、`design`→`plan` | **硬切**：无兼容候选、无别名 |
| 4 | 计划文档位置 | `docs/plan/`，并加 `docs/plan/.gitignore` |
| 5 | 代码改动方式 | **必须跑赛道**：契约（先红）→ 两条并行赛道 → CR 评审 → 提交胜者 |

## 1. 目标与非目标

**目标**

1. 流程目录硬切到 `docs/`，默认流程文件 `<项目根>/docs/racing-code.md`。
2. full 与 minimal 预设、仓库自身流程统一入口阶段 `plan`（标签「规划」）；不再出现 `design`。
3. 赛道名以工作分支为前缀（方案 B），避免不同工作分支（`0.0.x` / `0.4.x` / `main`）的赛道撞名。
4. 插件配置按项目生效：项目内 `.dsh/racing-code.yml` 决定 `flowPath` / `workBranch` / `enabled` / 护栏；全局只做兜底与总开关。

**非目标**

- 不重写/删除已存在的 `racing/*` 赛道分支与 worktree（历史保留）。
- 不引入子进程；`lib/flow.js`、`lib/bootstrap.js` 保持纯层（无 `node:` 依赖）。
- 不做 GUI。

## 2. 现状与证据（0.0.x）

| 项 | 现状 | 位置 |
|---|---|---|
| 默认流程路径 | `docs/racing-code.md`（已硬切） | `lib/sources.js`、`lib/index.js`、`cordis.patch.yml` |
| 入口阶段 | `plan`（已硬切） | `lib/bootstrap.js`、`docs/racing-code.md` |
| 赛道分支 | 硬编码 `racing/<lane-id>` | `lib/flow.js` `laneWorktree()` / `buildFlow()` / RULES；`lib/bootstrap.js` lane 说明与首次清单 |
| 配置 | `projectFlowPath` 是全局 profile 配置（当前钉死 QuantTrade 的 `0.4.x/docs/racing-code.md`） | `~/.dsh/profiles/web/cordis.patch.yml` |

## 3. 赛道名（方案 B）

**命名规则**

- 工作分支 `workBranch` 优先级：flow front-matter `workBranch` > `.dsh/racing-code.yml` 的 `workBranch` > **探测**（flow 文件所在 git worktree 的 `HEAD`）> 无前缀。
- 分支：`workBranch ? `${workBranch}-racing/${laneId}` : `racing/${laneId}``。
- 目录：`laneDir: branch` 时等于分支名（`0.0.x-racing/implement-a`）；默认布局仍是 `<laneDir>/<lane-id>`。
- 例：工作分支 `0.0.x`，lane `implement-a` → 分支与目录都是 `0.0.x-racing/implement-a`，位于容器根下、与 `0.0.x/` 同级。

**探测算法（无子进程，`ctx.fs`）**

1. 从解析到的 flow 文件路径逐级向 `<cwd>` 回溯，找最近的 `.git`；
2. `.git` 是目录 → 读 `<git>/HEAD`；是文件 → 解析 `gitdir:` 后读 `<gitdir>/HEAD`；
3. 取 `ref: refs/heads/<name>`；detached / bare / 读不到 → 视为未知；
4. 未知时不加前缀（退回 `racing/<lane-id>`），并报 `FLOW_WORK_BRANCH_UNKNOWN`（info），提示写 `workBranch`。

**逃生口**：front-matter `workBranch: ''`（或项目配置同理）显式关闭前缀。

## 4. 项目配置（方案 A）

**文件**：`<会话 cwd>/.dsh/racing-code.yml`（可选；DSH 已有 `<projectRoot>/.dsh/...` 约定）。

```yaml
racing-code: 1
enabled: true
bootstrapEnabled: true
flowPath: 0.0.x/docs/racing-code.md   # 相对会话 cwd；默认 docs/racing-code.md
workBranch: 0.0.x                     # 可选，缺省则探测
maxStageRepeats: 3
maxLanes: 4
maxReviewRounds: 2
```

**优先级**

- `flowPath` / `workBranch` / `enabled` / `bootstrapEnabled`：项目配置 > 全局 Config 兜底。
- 护栏：flow front-matter > 项目配置 > 全局 Config。
- `flowPath` 归一化后必须留在会话 cwd 之内（沿用 `checkBootstrapTarget` 的包含性校验）。
- 配置文件存在但解析失败 → `FLOW_PROJECT_CONFIG_INVALID`（warn），按全局兜底继续，不崩。

**全局侧**：`~/.dsh/profiles/web/cordis.patch.yml` 删除 `projectFlowPath`（保留字段作弃用兜底）；profile `package.json` 的 `link` / lock / HMR root 统一到同一 worktree 后重装。

## 5. 代码改动清单（走赛道）

- `lib/flow.js`：`resolveFlow(opts.workBranch)`、front-matter `workBranch`、`laneWorktree(laneId, laneDir, workBranch)`、`buildFlow()` 的 `lane.branch/worktree`、RULES 文案去硬编码。
- `lib/bootstrap.js`：模板 front-matter 生成 `workBranch`；首次清单与 plan 的 `git worktree add <dir> -b <branch>`；`laneBrief()`。
- `lib/sources.js`：`loadProjectConfig(fs, cwd)`、`discoverFlowPath`（硬切 `docs/racing-code.md`）、`detectWorkBranch(fs, file, cwd)`。
- `lib/index.js`：`Config`/`resolveConfig` 兜底、`readSource` 注入项目配置与 workBranch、`racing_code_init` 目标与写入。
- `test/*.mjs`：先写红契约（见 §6），实现者不得改测试。

## 6. 契约（先红）要点

- `workBranch`：无前缀 / 有前缀；front-matter 覆盖 opts；三种 `laneDir`；探测（普通仓库、worktree 容器、无 git、detached）。
- 项目配置：解析、优先级、`flowPath` 越界拒绝、坏配置降级、`enabled/bootstrapEnabled` 覆盖。
- bootstrap：模板首行 `workBranch`；落在模板里的分支名/目录名；plan 的 fix 命令。

## 7. 里程碑

1. **M1 硬切改名（已完成，直接提交）**：`doc`→`docs`、`design`→`plan`；`npm test` 115/115 全绿。
2. **M2 契约**：在 `0.0.x` 写红用例并提交（`contract: ... (red)`）。
3. **M3 赛道**：从契约提交开两条赛道（不同模型），只改 `lib/`，各自提交。
4. **M4 CR + 提交**：评审、按赛道发回问题、给胜者，合并胜者并回填文档。

## 8. 验收标准

- `cd 0.0.x && npm test` 全绿。
- `flow_stages` 返回 `entry: plan`、lane 分支 `<workBranch>-racing/<lane-id>`、worktree 与分支一致。
- 容器布局项目（本仓库、QuantTrade）用 `.dsh/racing-code.yml` 指向各自分支的 `docs/racing-code.md`，不再依赖全局 `projectFlowPath`。
- 旧 `racing/*` 分支不被改写；`lib/` 无具体模型名、无按阶段 id 分支。

## 9. 风险

| 风险 | 缓解 |
|---|---|
| 硬切 `docs` 打断旧项目 | 迁移说明 + 项目配置 `flowPath` 指旧路径 |
| 探测 `workBranch` 在 bare/detached 下失败 | front-matter / 项目配置覆盖；失败不加前缀 + info |
| 两条赛道都碰 `flow.js`/`bootstrap.js` 冲突 | 只合并胜者；CR 按赛道切分问题 |
| 全局侧链接与 HMR 不一致 | M4 统一到同一 worktree 并重装 |
