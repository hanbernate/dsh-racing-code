/**
 * Pure half of the new-project bootstrap: a project without a flow file stays silent, so
 * the only way to create one is an explicit instruction that goes through this layer —
 * the template text, the per-node model tabs, the pre-flight plan and the protocol of the
 * two user gates.
 *
 * Everything here is pure on purpose: no `node:` import and no `@deepseek-ai/*` import
 * (see test/package.test.mjs), so each function takes plain facts — never a filesystem —
 * and the host half owns every read and write. The one allowed import is the pure
 * `./flow.js` resolver, because {@link renderBootstrapTemplate} enforces the generator's
 * red line **in this layer**: the text it returns is resolved through `resolveFlow` and
 * must come out with **zero** errors, or nothing is returned at all.
 *
 * Nothing here picks a model for the user: {@link buildRouteChoices} offers the **whole**
 * local llm directory and marks which entries the subagent allowlist already authorizes;
 * every choice (default `session`) stays with the tabs the orchestrator shows, and a route
 * picked outside the allowlist is appended to it by the host half (plan §3).
 *
 * @module dsh-racing-code/bootstrap
 */

import { resolveFlow } from './flow.js'

/**
 * @typedef {object} Route
 * @property {string} provider
 * @property {string} model
 */

/**
 * @typedef {object} CatalogRoute
 * @property {string} provider
 * @property {string} model
 * @property {string} [note] Free-text remark shown next to the tab (authorization, upstream).
 */

/**
 * Which preset {@link renderBootstrapTemplate} writes, and the facts it needs.
 *
 * @typedef {object} BootstrapSpec
 * @property {'full'|'minimal'} template `full` is the repository's own graph; `minimal`
 *   drops the plan/final/needs-code prologue.
 * @property {2|3|4} [lanes] How many stages the race group fans out to. Default 2.
 * @property {Record<string, string>} [models] Stage id → `provider/model` or the literal
 *   `session` (decision 3: an explicit "use the current session model", which never
 *   warns). Every stage of the graph gets its own front-matter entry; a missing key is
 *   rendered as `session`.
 * @property {{maxStageRepeats?: number, maxLanes?: number, maxReviewRounds?: number}} [guards]
 *   Front-matter guards; omitted keys fall back to 3 / 4 / 2.
 * @property {string} [laneDir] Front-matter `laneDir`. Omit it for the default
 *   `.worktrees` layout (`git-repo` / `none`); pass `branch` inside a worktree container,
 *   where the lane directory is the branch name.
 * @property {string} [workBranch] Front-matter `workBranch`: the working branch prefixed onto
 *   every lane branch (scheme B, `<workBranch>-racing/<lane-id>`). Omit for no prefix;
 *   `''` emits the explicit off (`workBranch: ""`).
 * @property {string} [generatedOn] ISO date stamped into a non-prompt HTML comment.
 */

/** @typedef {'ok'|'warn'|'blocked'} PlanStatus */

/**
 * @typedef {object} PlanItem
 * @property {string} item Short id of the check (stable within one call).
 * @property {PlanStatus} status `blocked` means "fix this before writing the file".
 * @property {string} detail One human sentence: what was found.
 * @property {string} [fix] Command or action that clears a warn/blocked item.
 */

/**
 * Everything {@link buildPlan} needs, computed by the host half (the pure layer never
 * touches the filesystem, and never runs a subprocess).
 *
 * @typedef {object} BootstrapFacts
 * @property {string} file Absolute target path (`flowFilePath(cwd, projectFlowPath)`).
 * @property {boolean} fileExists True when that file already exists.
 * @property {boolean} parentExists True when the file's parent directory exists.
 * @property {'worktree-container'|'git-repo'|'none'|'unknown'} gitLayout fs heuristic:
 *   `.git` is a file containing `gitdir:` with a sibling `.bare/` → `worktree-container`;
 *   `.git` is a directory → `git-repo`; no `.git` → `none`; a `gitdir:` target that
 *   does not exist → `unknown`.
 * @property {string} [laneDir] Effective `laneDir`; omitted means the default `.worktrees`.
 * @property {string} [workBranch] Working branch prefixed onto every lane branch (scheme B);
 *   omitted or empty means no prefix (`racing/<lane-id>`).
 * @property {string|null} gitignore Contents of `<cwd>/.gitignore`, or null when there is none.
 * @property {ChoiceNode[]} nodes Choice nodes, as returned by {@link buildRouteChoices}.
 * @property {RouteCandidate[]} candidates The route pool the tabs will offer — the whole
 *   llm directory, each entry carrying its authorization (plan §3.1).
 */

/**
 * One tab of gate 2: a stage, its brief, and the routes the user may pick for it.
 *
 * @typedef {object} RouteCandidate
 * @property {string} provider
 * @property {string} model
 * @property {string} [note] Free-text remark shown next to the tab.
 * @property {boolean} authorized True when the subagent allowlist already contains the
 *   route. When the allowlist service is unavailable the check is skipped and every
 *   candidate is authorized.
 * @property {boolean} willAllowlist True when picking this route appends it to the
 *   allowlist (i.e. not authorized **and** the caller said the allowlist is writable).
 */

/**
 * One tab of gate 2: a stage, its brief, and the routes the user may pick for it.
 *
 * @typedef {object} ChoiceNode
 * @property {string} id Stage id.
 * @property {'stage'|'lane'} kind `lane` for a stage that runs in a parallel lane.
 * @property {string} label Stage label, as rendered in the graph.
 * @property {string} brief Stage brief (`''` when the stage has none).
 * @property {boolean} required True for lane stages: the user must pick a route for them.
 * @property {'session'} default The tab's default option: "use the current session model".
 * @property {RouteCandidate[]} candidates Never contains `session`; may be empty.
 */

// ─────────────────────────────── the two presets ───────────────────────────────

const LANE_SUFFIXES = ['a', 'b', 'c', 'd']
const LANE_LETTERS = ['A', 'B', 'C', 'D']
const GUARD_FALLBACKS = [['maxStageRepeats', 3], ['maxLanes', 4], ['maxReviewRounds', 2]]
const ROUTE_TEXT_RE = /^([A-Za-z0-9._-]+)\s*[·/]\s*([A-Za-z0-9._/-]+)$/

/** The executable stage briefs: one '### <id>' section each, 2–4 actionable lines. */
const IN_SESSION_LINE = '- 本阶段：配置里声明了模型就委派子代理；没声明（session/缺键）就在当前会话直接执行。'
const BRIEFS = {
  plan: [
    IN_SESSION_LINE,
    '- 产出设计文档或最短执行计划（流程图 + 每阶段契约与验收标准）；本阶段不写实现。',
    '- 结构与措辞都可与用户反复调整，经用户确认后再开契约与并行实现。',
  ],
  'contract-tests': [
    IN_SESSION_LINE,
    '- 只写契约测试（先红后绿），不改实现，不删用例，不新建测试文件。',
    '- 契约本身有矛盾（测试互斥、JSDoc 与测试冲突）就停下问用户，不自行改测试。',
  ],
  cr: [
    IN_SESSION_LINE,
    '- 逐条赛道评审 diff 与自检结论，问题按赛道切分、原路发回修订。',
    '- 先给建议与依据；提问前先把完整材料发出来（问题清单逐条全文、diff 摘要、建议），等待给足，不替用户决定。',
    '- 评审者与某条赛道同模型会有自评偏好：避开或单独指定。',
  ],
  commit: [
    '- 本阶段声明了模型才委派；没声明就在当前会话直接执行。',
    '- 胜者合入当前工作分支（不直接落 main）；落败赛道的分支保留。',
    '- 汇总胜者改动并提交；提交前确认工作区干净。',
    '- 落败赛道 worktree 的去留由用户决定，不擅自删分支或丢未提交内容。',
  ],
}

/** The lane stage's brief: same independence rules, with its own branch name spelled out. */
function laneBrief(id, branch) {
  return [
    `- 在自己的 worktree（分支 ${branch}，绝对路径以 flow_stages 的 lane 字段为准）内按契约实现，测试全绿后提交到该分支。`,
    '- 不看其它赛道的 worktree；独立作答，把结论写进汇报。',
  ]
}

/**
 * The two preset graphs, in declaration order. Node order matters: `buildFlow` lists
 * stages in declaration order, and the tests pin the stage order (entry first, lanes in
 * the middle, `commit` last) — so each preset declares `commit` on the incoming edge that
 * introduces it (a bare `commit` afterwards, never a second `["提交"]`).
 * Lane stages carry `lane: true` so callers never have to guess "is this a lane?" from the
 * id: the graph definition says so.
 * @returns {{stages: {id: string, label: string, lane?: boolean}[], lines: string[]}}
 */
function graphFor(template, laneCount) {
  const lanes = []
  for (let index = 0; index < laneCount; index++) {
    lanes.push({ id: `implement-${LANE_SUFFIXES[index]}`, label: `实现 ${LANE_LETTERS[index]}`, lane: true })
  }
  const stages = template === 'full'
    ? [{ id: 'plan', label: '规划' }, { id: 'contract-tests', label: '接口 + 测试' }, ...lanes, { id: 'cr', label: 'CR 评审' }, { id: 'commit', label: '提交' }]
    : [{ id: 'plan', label: '规划' }, { id: 'contract-tests', label: '接口 + 测试' }, ...lanes, { id: 'cr', label: 'CR 评审' }, { id: 'commit', label: '提交' }]

  const lines = ['flowchart TD']
  lines.push(template === 'full' ? '  %% entry: plan' : '  %% entry: plan')
  if (template === 'full') {
    lines.push(
      '  plan["规划"] --> final(["用户定稿?"])',
      '  final -- "否" --> plan',
      '  final -- "是" --> needs-code{"要改代码吗?"}',
      '  needs-code -- "是" --> contract-tests["接口 + 测试"]',
    )
  } else {
    lines.push('  plan["规划"] --> contract-tests["接口 + 测试"]')
  }
  lines.push('  contract-tests --> race{{"并行实现"}}')
  for (const lane of lanes) lines.push(`  race --> ${lane.id}["${lane.label}"]`)
  lanes.forEach((lane, index) => lines.push(index === 0 ? `  ${lane.id} --> cr["CR 评审"]` : `  ${lane.id} --> cr`))
  if (template === 'full') {
    lines.push(
      '  cr --> common{"存在共同问题?"}',
      '  common -- "有" --> gate(["用户决定：完善约束还是接受现状"])',
      '  common -- "无" --> verdict{"每条赛道都通过?"}',
      '  gate -- "完善约束" --> plan',
      '  gate -- "接受现状" --> verdict',
      // verdict 的"否"不再直达 race：把意见发回赛道前先过 confirm 用户关口（与本仓库
      // docs/racing-code.md 同构）。confirm 是用户关口、不是阶段，所以不进 stages；
      // commit 的首次声明（带形状那行）仍在图尾，阶段顺序不变。
      '  verdict -- "否：按反馈修订" --> confirm(["用户确认：把 CR 意见发回赛道?"])',
      '  needs-code -- "否：纯文档改动" --> commit["提交"]',
      '  verdict -- "是" --> commit',
      '  confirm -- "发回修订" --> race',
      '  confirm -- "先完善约束" --> plan',
      '  confirm -- "接受现状" --> commit',
    )
  } else {
    lines.push(
      '  cr --> verdict{"每条赛道都通过?"}',
      '  verdict -- "否：按反馈修订" --> race',
      '  verdict -- "是" --> commit["提交"]',
    )
  }
  return { stages, lines }
}

// ─────────────────────────────── helpers ───────────────────────────────

/** Fold `.` and `..` and duplicate slashes out of a posix path (the pure layer has no node:path). */
function foldPath(path) {
  const absolute = path.startsWith('/')
  const out = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') { if (out.length > 0) out.pop(); continue }
    out.push(segment)
  }
  return (absolute ? '/' : '') + out.join('/')
}

/** True when `text` is one relative directory name, as `resolveLaneDir` in flow.js accepts. */
function isLaneDirName(text) {
  return text !== '' && !text.startsWith('~') && !text.includes('..') && !text.includes('/') && !text.includes('\\')
}

// ─────────────────────────────── the five pure functions ───────────────────────────────

/**
 * Render the whole flow file: front matter (format version, guards, optional `laneDir`,
 * and a `models:` entry for every stage — the given route, or `session`), the mermaid
 * graph, a deletable `## 首次清单` checklist (git / worktree / ignore commands, not part of
 * the prompt), and one `### <id>` brief per stage so `flow_stages` can answer with
 * instructions.
 *
 * Preconditions: `template` is `'full'` or `'minimal'`; `lanes` is 2, 3 or 4 and does not
 * exceed `guards.maxLanes`; every `models` value is `session` or a `provider/model` string;
 * every `models` key is a stage of the rendered graph.
 *
 * Postconditions: the returned text resolves through `resolveFlow` with zero errors and
 * every stage has a non-empty brief — a spec that cannot satisfy this is rejected instead
 * of written (`write` never lands a half-valid file).
 *
 * @param {BootstrapSpec} spec
 * @returns {string} The complete file text — the same text the preview shows and the write lands.
 * @throws {Error} Message starting with `BOOTSTRAP_TEMPLATE_INVALID` when the spec is unusable
 *   (unknown preset, lanes outside 2–4 or above `maxLanes`, a model value that is neither
 *   `session` nor a route) or when the rendered text would not resolve with zero errors.
 */
export function renderBootstrapTemplate(spec) {
  const s = spec && typeof spec === 'object' ? spec : {}
  const invalid = message => { throw new Error(`BOOTSTRAP_TEMPLATE_INVALID ${message}`) }

  if (s.template !== 'full' && s.template !== 'minimal')
    invalid(`template 必须是 'full' 或 'minimal'，收到 ${JSON.stringify(s.template)}`)

  const guards = {}
  for (const [key, fallback] of GUARD_FALLBACKS) {
    const raw = s.guards?.[key]
    if (raw === undefined) { guards[key] = fallback; continue }
    if (!Number.isInteger(raw) || raw <= 0) invalid(`guards.${key} 必须是正整数，收到 ${JSON.stringify(raw)}`)
    guards[key] = raw
  }

  const lanes = s.lanes === undefined ? 2 : s.lanes
  if (!Number.isInteger(lanes) || lanes < 2 || lanes > 4)
    invalid(`lanes 必须是 2、3 或 4，收到 ${JSON.stringify(s.lanes)}`)
  if (lanes > guards.maxLanes) invalid(`lanes ${lanes} 超过 guards.maxLanes ${guards.maxLanes}`)

  let laneDir
  if (s.laneDir !== undefined) {
    const text = typeof s.laneDir === 'string' ? s.laneDir.trim() : ''
    if (!isLaneDirName(text)) invalid(`laneDir ${JSON.stringify(s.laneDir)} 不是合法的目录名（非空、单个相对目录、不含 ..）`)
    laneDir = text
  }

  // Lane-naming prefix (scheme B): the working branch, `''` = the explicit off.
  let workBranch
  if (s.workBranch !== undefined) {
    if (typeof s.workBranch !== 'string' && typeof s.workBranch !== 'number')
      invalid(`workBranch 必须是字符串（"" 表示显式关闭前缀），收到 ${JSON.stringify(s.workBranch)}`)
    workBranch = String(s.workBranch).trim()
    if (/\s/.test(workBranch)) invalid(`workBranch ${JSON.stringify(s.workBranch)} 不能含空白`)
  }

  let generatedOn
  if (s.generatedOn !== undefined) {
    // YYYY-MM-DD only: the stamp lands in an HTML comment, so anything else (notably a
    // `-->`) could close it early or smuggle text into the file body.
    if (typeof s.generatedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.generatedOn))
      invalid(`generatedOn 必须是 YYYY-MM-DD 日期，收到 ${JSON.stringify(s.generatedOn)}`)
    generatedOn = s.generatedOn
  }

  const { stages, lines } = graphFor(s.template, lanes)

  const given = s.models && typeof s.models === 'object' && !Array.isArray(s.models) ? s.models : {}
  const known = new Set(stages.map(stage => stage.id))
  for (const key of Object.keys(given)) {
    if (!known.has(key))
      invalid(`models 里的 ${key} 不是这张图里的阶段（这张图的阶段：${[...known].join(', ')}）`)
  }
  const models = new Map()
  for (const stage of stages) {
    const raw = given[stage.id]
    if (raw === undefined) { models.set(stage.id, 'session'); continue }
    if (typeof raw !== 'string')
      invalid(`models.${stage.id} 必须是 'provider/model' 或 'session' 字符串，收到 ${typeof raw}`)
    const value = raw.trim()
    if (value === 'session') { models.set(stage.id, 'session'); continue }
    const match = ROUTE_TEXT_RE.exec(value)
    if (!match) invalid(`models.${stage.id} 既不是 session 也不是 "provider/model" 路由：${JSON.stringify(raw)}`)
    models.set(stage.id, `${match[1]}/${match[2]}`)
  }

  const out = []
  out.push(
    '---',
    'racing-code: 1',
    `maxStageRepeats: ${guards.maxStageRepeats}`,
    `maxLanes: ${guards.maxLanes}`,
    `maxReviewRounds: ${guards.maxReviewRounds}`,
  )
  if (laneDir !== undefined) out.push(`laneDir: ${laneDir}`)
  if (workBranch !== undefined) out.push(workBranch === '' ? 'workBranch: ""' : `workBranch: ${workBranch}`)
  out.push('models:')
  for (const stage of stages) out.push(`  ${stage.id}: ${models.get(stage.id)}`)
  out.push('---', '')

  if (generatedOn) out.push(`<!-- 由 racing-code bootstrap 生成于 ${generatedOn}；本注释不进入提示词。 -->`, '')

  out.push('# 开发流程', '', '```mermaid', ...lines, '```', '')
  // 路由分流的抬头：生成的流程文件自己说清"哪些阶段在当前会话跑、哪些永远委派"。
  out.push('路由分流：显式声明 provider/model → 委派一次前台子代理；未声明（session/缺键）→ 在当前会话直接执行；lane 永远委派（lane 选 session = 子代理继承会话模型）。', '')

  // 首次清单：给仓库维护者的核对单，不进入提示词（随文件 commit/review，可整节删除）。
  const branchOf = id => workBranch ? `${workBranch}-racing/${id}` : `racing/${id}`
  const wtDir = id => laneDir === 'branch' ? branchOf(id) : `${laneDir ?? '.worktrees'}/${id}`
  const laneStages = stages.filter(stage => stage.lane)
  out.push('## 首次清单', '')
  out.push('<!-- 本节是仓库维护者的核对单，不进入提示词；流程跑顺后可整节删除。 -->', '')
  out.push(`- [ ] 并行赛道每条一个 worktree（开赛前建好；分支统一为 ${workBranch ? `${workBranch}-racing/<lane-id>` : 'racing/<lane-id>'}）：`, '')
  out.push('  ```bash')
  for (const lane of laneStages) out.push(`  git worktree add ${wtDir(lane.id)} -b ${branchOf(lane.id)}`)
  out.push('  ```', '')
  out.push(laneDir === 'branch'
    ? `- [ ] worktree 容器布局：赛道目录就是分支名（${branchOf('<lane-id>')} 的形态），无需额外的忽略规则。`
    : '- [ ] 默认布局：把赛道目录（上面命令的前缀目录）加进 .gitignore，worktree 不污染 git status。')
  out.push('- [ ] 项目还不是 git 仓库时：先 git init 并完成首次提交，再建 worktree。', '')

  // 阶段说明：### <id> 每节 2–4 行可执行规则，会成为 flow_stages 的阶段说明。
  out.push('## 阶段说明', '')
  for (const stage of stages) {
    const body = stage.lane ? laneBrief(stage.id, branchOf(stage.id)) : (BRIEFS[stage.id] ?? ['- 本阶段的契约待补。'])
    out.push(`### ${stage.id}`, ...body, '')
  }
  const text = out.join('\n')
  // The generator's red line, enforced here in the pure layer (not left to the host): the
  // text must resolve through `resolveFlow` with zero errors — otherwise this is a spec
  // the renderer cannot satisfy, and it is rejected instead of returned for writing.
  const resolved = resolveFlow(text)
  if (!resolved.ok) {
    const errors = resolved.problems.filter(item => item.level === 'error')
    invalid(`渲染自检未通过（${errors.map(item => item.code).join(', ') || '未知错误'}）：拒绝返回会落成坏流程文件的文本`)
  }
  return text
}

/**
 * Build gate 2's tabs: one node per stage, in flow order, each carrying the routes the user
 * may pick from (default: `session`, which is never listed as a candidate).
 *
 * The candidate pool is the **whole** local llm directory (plan §3.1), in directory order,
 * deduped by provider/model: it is no longer intersected with the subagent allowlist, so a
 * model the user can pick but has not authorized yet still shows up. Each candidate carries
 * `authorized` (is it in the allowlist?) and `willAllowlist` (`!authorized` and the caller
 * says the allowlist is writable, i.e. picking it appends it).
 *
 * Boundary semantics: `allowedModels === null` (the allowlist service is unavailable) skips
 * the check — every candidate is `authorized`, none is `willAllowlist`, and the notes carry
 * `BOOTSTRAP_ALLOWLIST_UNAVAILABLE`; `allowedModels: []` is a known-empty allowlist and
 * makes every candidate unauthorized; `catalog` null or empty is the only way to get zero
 * candidates (`BOOTSTRAP_NO_CANDIDATES`), because an empty allowlist no longer hides the
 * directory.
 *
 * @param {{stages?: {id: string, label?: string, brief?: string, instruction?: string}[],
 *          lanes?: ({id: string, joinAt?: string}|string)[],
 *          allowedModels?: Route[]|null,
 *          allowlistWritable?: boolean,
 *          catalog?: CatalogRoute[]|null}} [input] `stages` is in flow order and is usually
 *   the resolved flow's stage list (`instruction` is read as the brief when `brief` is
 *   absent); `lanes` names the stages that run in a parallel lane, `joinAt` naming the
 *   stage that reviews them; `allowlistWritable` says whether the host can append to the
 *   allowlist (default false: nothing is promised to the user).
 * @returns {{nodes: ChoiceNode[], notes: string[]}} `notes` are diagnostic lines — a
 *   `BOOTSTRAP_*` code plus a sentence — for the orchestrator's questions and the tool output:
 *   `BOOTSTRAP_NO_CANDIDATES` (directory empty/unavailable), `BOOTSTRAP_ALLOWLIST_WILL_ADD`
 *   (at least one candidate would be appended on selection) and
 *   `BOOTSTRAP_ALLOWLIST_UNAVAILABLE` (the check could not run).
 *   When a lane names its `joinAt`, the notes also carry the reviewer's self-preference
 *   advisory (a tab that reuses a lane's model would review a model it agrees with), naming
 *   the reviewer so the orchestrator can ask about it.
 */
export function buildRouteChoices(input) {
  const src = input && typeof input === 'object' ? input : {}
  const stages = Array.isArray(src.stages) ? src.stages : []
  const lanesInput = Array.isArray(src.lanes) ? src.lanes : []
  const allowed = Array.isArray(src.allowedModels) ? src.allowedModels : null
  const catalog = Array.isArray(src.catalog) ? src.catalog : null
  const allowlistWritable = src.allowlistWritable === true

  const lanes = new Map()
  for (const lane of lanesInput) {
    const id = typeof lane === 'string' ? lane : lane && typeof lane === 'object' ? lane.id : undefined
    if (typeof id !== 'string' || id === '') continue
    const joinAt = lane && typeof lane === 'object' && typeof lane.joinAt === 'string' && lane.joinAt !== '' ? lane.joinAt : undefined
    if (!lanes.has(id)) lanes.set(id, joinAt)
  }

  const usable = entry => entry && typeof entry === 'object'
    && typeof entry.provider === 'string' && entry.provider.trim() !== ''
    && typeof entry.model === 'string' && entry.model.trim() !== ''
  const sameRoute = (a, b) => a.provider === b.provider && a.model === b.model

  // The pool: the **whole** local llm directory, in directory order (plan §3.1). Each entry
  // carries its own authorization instead of being filtered away: `authorized` says whether
  // the subagent allowlist already contains it, `willAllowlist` says a pick would append it.
  // A missing allowlist (null) means the check cannot run: everything counts as authorized
  // and nothing is promised.
  const pool = (catalog ?? []).filter(usable).map(entry => {
    const authorized = allowed === null || allowed.some(route => usable(route) && sameRoute(route, entry))
    return { ...entry, authorized, willAllowlist: !authorized && allowlistWritable }
  })

  const nodes = stages
    .filter(stage => stage && typeof stage === 'object' && typeof stage.id === 'string' && stage.id !== '')
    .map(stage => {
      const isLane = lanes.has(stage.id)
      const brief = typeof stage.brief === 'string' && stage.brief.trim() !== ''
        ? stage.brief
        : (typeof stage.instruction === 'string' ? stage.instruction : '')
      return {
        id: stage.id,
        kind: isLane ? 'lane' : 'stage',
        label: typeof stage.label === 'string' && stage.label.trim() !== '' ? stage.label : stage.id,
        brief,
        required: isLane,
        default: 'session',
        candidates: pool.map(entry => ({ ...entry })),
      }
    })

  const notes = []
  // Only a missing or empty **directory** leaves zero candidates (plan §3.1): an empty
  // allowlist is a decision, not a reason to hide the directory.
  if (nodes.length > 0 && pool.length === 0) {
    notes.push('BOOTSTRAP_NO_CANDIDATES 候选路由池为空（本地 llm 目录缺失、不可用或没有可用的 provider/model）：每个节点只剩"用当前会话模型"一个选项。')
  }
  const willAdd = pool.filter(entry => entry.willAllowlist).length
  if (willAdd > 0) {
    notes.push(`BOOTSTRAP_ALLOWLIST_WILL_ADD 目录里有 ${willAdd} 条路由不在子代理白名单里：用户在节点选项卡上选中后，插件会把该路由追加进 subagent-model-selection-settings.allowedModels（只追加、不改动已有条目与顺序；新会话生效）。`)
  }
  if (allowed === null) {
    notes.push('BOOTSTRAP_ALLOWLIST_UNAVAILABLE 读不到子代理白名单（服务不可用或已关闭）：候选仍列出 llm 目录全量，但无法校验、也不承诺加白；必要时请手动在 Settings → Subagent delegation 里添加。')
  }
  const advised = new Set()
  for (const [, joinAt] of lanes) {
    if (!joinAt || advised.has(joinAt)) continue
    advised.add(joinAt)
    const laneNames = nodes.filter(node => node.kind === 'lane').map(node => node.id).join(' ∥ ')
    notes.push(`BOOTSTRAP_CR_REUSE_RISK 评审阶段 ${joinAt} 汇合 ${laneNames || '（无赛道）'}：默认走当前会话模型；`
      + `若它与某条赛道选了同一个模型，评审会有自评偏好，请为 ${joinAt} 单独指定或避开。`)
  }
  return { nodes, notes }
}

/**
 * Build the pre-flight plan shown with the preview: what the orchestrator must check (and,
 * for `warn`/`blocked`, fix with the user's consent) before the file is written.
 *
 * The facts that matter: the target file and its parent directory, the git layout
 * (`worktree-container` → an "open the lanes" `git worktree add` command; `git-repo` →
 * `.gitignore` must ignore the default lane dir; `none` → blocked until `git init`;
 * `unknown` → warn about the broken `gitdir:`), the effective `laneDir`, the route pool,
 * and the required lane picks. Nothing here runs a subprocess.
 *
 * @param {BootstrapFacts} facts
 * @returns {PlanItem[]}
 */
export function buildPlan(facts) {
  const f = facts && typeof facts === 'object' ? facts : {}
  const file = typeof f.file === 'string' && f.file !== '' ? f.file : '(目标未定)'
  const fileExists = f.fileExists === true
  const parentExists = f.parentExists !== false
  const layout = f.gitLayout
  const laneDir = typeof f.laneDir === 'string' && f.laneDir !== '' ? f.laneDir : '.worktrees'
  const workBranch = typeof f.workBranch === 'string' ? f.workBranch.trim()
    : typeof f.workBranch === 'number' ? String(f.workBranch) : ''
  const gitignore = typeof f.gitignore === 'string' ? f.gitignore : null
  const nodes = Array.isArray(f.nodes) ? f.nodes : []
  const candidates = Array.isArray(f.candidates) ? f.candidates : []
  const laneIds = nodes.filter(node => node && typeof node === 'object' && node.kind === 'lane' && typeof node.id === 'string')
    .map(node => node.id)
  const branchOf = id => workBranch ? `${workBranch}-racing/${id}` : `racing/${id}`
  const wtDir = id => laneDir === 'branch' ? branchOf(id) : `${laneDir}/${id}`

  const plan = []

  plan.push(fileExists
    ? {
        item: 'target', status: 'warn',
        detail: `目标 ${file} 已存在：默认拒写（BOOTSTRAP_FILE_EXISTS），只对解析失败的坏文件用 force 覆盖。`,
        fix: '确认要覆盖后，带 write:true + force:true 重新执行；覆盖前先备份。',
      }
    : { item: 'target', status: 'ok', detail: `目标 ${file} 尚不存在：write:true 时按 createIfAbsent 新建。` })
  if (!parentExists) {
    const parent = file.slice(0, Math.max(file.lastIndexOf('/'), 0)) || '.'
    plan.push({
      item: 'parent', status: 'blocked',
      detail: `目标文件的父目录 ${parent} 不存在：写入会被拒绝（BOOTSTRAP_PARENT_MISSING），插件不代建目录。`,
      fix: `mkdir -p ${parent}`,
    })
  }

  if (layout === 'worktree-container') {
    plan.push({
      item: 'git', status: 'ok',
      detail: `检测到 worktree 容器布局（.git 指向 .bare）：赛道目录用分支名 ${branchOf('<lane-id>')}，无需忽略规则。`,
    })
    if (laneIds.length > 0) {
      plan.push({
        item: 'worktrees', status: 'ok',
        detail: `开赛前为每条并行赛道建好 worktree（${laneIds.map(wtDir).join('、')}）。`,
        fix: laneIds.map(id => `git worktree add ${wtDir(id)} -b ${branchOf(id)}`).join('\n'),
      })
    }
  } else if (layout === 'git-repo') {
    plan.push({
      item: 'git', status: 'ok',
      detail: `普通 git 仓库：每条赛道一个 worktree，放在 ${laneDir}/ 下（分支仍为 ${branchOf('<lane-id>')}）。`,
    })
    if (laneIds.length > 0) {
      plan.push({
        item: 'worktrees', status: 'ok',
        detail: `开赛前为每条并行赛道建好 worktree（${laneIds.map(wtDir).join('、')}）。`,
        fix: laneIds.map(id => `git worktree add ${wtDir(id)} -b ${branchOf(id)}`).join('\n'),
      })
    }
    const ignored = gitignore !== null && gitignore.split('\n').some(line => {
      const text = line.trim()
      return text === laneDir || text === `${laneDir}/` || text.startsWith(`${laneDir}/`) || text === `/${laneDir}/`
    })
    plan.push(ignored
      ? { item: 'gitignore', status: 'ok', detail: `${laneDir}/ 已在 .gitignore 里，赛道 worktree 不会污染 git status。` }
      : {
          item: 'gitignore', status: 'warn',
          detail: `并行赛道的 worktree 放在 ${laneDir}/ 下，但 .gitignore 还没忽略它：赛道目录会出现在 git status 里。`,
          fix: `echo '${laneDir}/' >> .gitignore`,
        })
  } else if (layout === 'none') {
    plan.push({
      item: 'git', status: 'blocked',
      detail: '这里不是 git 仓库（没有 .git）：并行赛道需要分支与 worktree，开不起来。',
      fix: 'git init 并完成首次提交后再运行引导。',
    })
  } else {
    plan.push({
      item: 'git', status: 'warn',
      detail: '.git 是 gitdir: 指针，但指向的位置不存在（裸仓库可能被移动或删除）：布局判不准，先修指针。',
      fix: '修正 .git 文件里的 gitdir: 路径，或重建 .bare/worktrees 结构后重新预览。',
    })
  }

  if (candidates.length === 0) {
    plan.push({
      item: 'candidates', status: 'warn',
      detail: '候选路由池为空（BOOTSTRAP_NO_CANDIDATES）：本地 llm 目录缺失或为空，每个节点只剩"用当前会话模型"一个选项。',
      fix: '先让 DSH 的 llm 目录至少广告一条 provider/model。',
    })
  } else {
    const unauthorized = candidates.filter(entry => entry && entry.authorized === false).length
    plan.push({
      item: 'candidates', status: 'ok',
      detail: `候选路由池有 ${candidates.length} 条（来自 DSH 的 llm 目录全量，目录原序）：其中 ${unauthorized} 条未授权，选中后由工具追加进子代理白名单；介入 2 会按节点逐个问。`,
    })
  }
  if (laneIds.length > 0) {
    plan.push({
      item: 'choices', status: 'ok',
      detail: `介入 2 必须为 ${laneIds.length} 条并行赛道（${laneIds.join('、')}）各选一个模型，缺一个就拒写（BOOTSTRAP_CHOICE_REQUIRED）；其余阶段默认用当前会话模型。`,
    })
  }
  return plan
}

/**
 * Decide the absolute target of the write and prove that it stays inside `cwd`.
 *
 * Containment is string-level and posix-shaped (the pure layer has no `node:path`):
 * a relative `projectFlowPath` is joined to `cwd`, `.` and `..` are folded away, and the
 * result must be `cwd` itself or a descendant of it. An absolute `projectFlowPath` is
 * accepted only when it already is inside `cwd`. An empty `projectFlowPath` means the
 * default `docs/racing-code.md`; a `cwd` that is not an absolute path cannot anchor
 * containment and is rejected as well.
 *
 * @param {{cwd: string, projectFlowPath: string}} input
 * @returns {{ok: true, file: string}
 *   | {ok: false, code: 'BOOTSTRAP_TARGET_OUTSIDE_ROOT', message: string}}
 */
export function checkBootstrapTarget(input) {
  const src = input && typeof input === 'object' ? input : {}
  const cwdRaw = String(src.cwd ?? '')
  const configured = String(src.projectFlowPath ?? '')
  const reject = message => ({ ok: false, code: 'BOOTSTRAP_TARGET_OUTSIDE_ROOT', message })

  if (!cwdRaw.startsWith('/'))
    return reject(`cwd ${JSON.stringify(cwdRaw)} 不是绝对路径，无法校验写入目标必须留在项目根内`)
  const cwd = foldPath(cwdRaw)
  const raw = configured.trim() === '' ? 'docs/racing-code.md' : configured
  const target = raw.startsWith('/') ? foldPath(raw) : foldPath(`${cwd}/${raw}`)
  if (target === '' || target === '.')
    return reject(`projectFlowPath ${JSON.stringify(configured)} 归一化后为空`)
  if (target === cwd || cwd === '/' || target.startsWith(`${cwd}/`)) return { ok: true, file: target }
  return reject(`写入目标 ${target} 不在项目根 ${cwd} 内：换 projectFlowPath 或把文件放进项目根下`)
}

/**
 * The two-gate protocol as text. A project without a flow file stays silent — no section,
 * no diagnostics — so this text is the only place the interaction contract lives, and the
 * tool must return it with every preview.
 *
 * One element per step, in order: preview (`write:false` only) → gate 1 confirms the
 * structure before any model question → gate 2 picks a route per node (lanes required,
 * default `session`) → `write:true` lands the file → `BOOTSTRAP_RESTART_REQUIRED`, because
 * only a new session picks the file up → the git / worktree / `.gitignore` commands stay
 * with the orchestrator, never with the plugin.
 *
 * Step 7 must state where the candidates come from — the **whole** DSH llm directory, not
 * just the subagent allowlist — and that a route picked outside the allowlist is appended
 * to it, taking effect in the next session (plan §3.2).
 *
 * @param {{file: string, lanes: number}} input
 * @returns {string[]} Nine steps, never empty; `file` and `lanes` appear in the text.
 */
export function bootstrapProtocol(input) {
  const src = input && typeof input === 'object' ? input : {}
  const file = String(src.file ?? '')
  const lanes = Number.isInteger(src.lanes) ? src.lanes : 2
  return [
    '第 1 步（用户）：只有用户明确说"给这个项目启动 racing-code"才开始；没有流程文件时插件保持沉默，不会有任何自动提示。',
    '第 2 步（编排者）：调用 racing_code_init({ write: false })，只预览、不写盘。',
    `第 3 步（工具）：返回结构预览——mermaid 图、阶段清单与阶段说明、护栏、目标路径 ${file}、plan（前置检查）、nodes（每节点可选项）、protocol（本协议原文）；预览里所有阶段模型一律渲染成 session，让结构成为焦点。`,
    `第 4 步（编排者 → 介入 1）：用 ask_user_question 请用户确认流程结构（预设 full/minimal、并行赛道 ${lanes} 条、阶段说明用词都可改）。`,
    '第 5 步（用户）：确认流程，或提出修改；要改就回到第 2 步重新预览，循环到用户确认为止。介入 1 结束前不问任何模型问题。',
    `第 6 步（编排者 → 介入 2）：按流程顺序（入口→出口，跳过并行组/判定/用户关口）逐节点发问；其中 ${lanes} 条并行赛道节点必选。`,
    '第 7 步（用户）：每个节点选一个——"用当前会话模型（默认）"或候选路由（附授权与上游备注）；候选来自 DSH 的 llm 目录全量（目录原序），不在子代理白名单里的会标注"未授权（选中后自动加入白名单）"——选中后由工具把该路由追加进白名单（只追加，新会话生效）。CR 那题写明：默认走会话模型，与某条赛道同模型会有自评偏好，请避开或单独指定。',
    '第 8 步（编排者）：收齐全部选择后调用 racing_code_init({ models: {...}, write: true })——工具自校验 0 error 后以 createIfAbsent 落盘（覆盖坏文件要 force）。',
    '第 9 步（工具/编排者）：返回计划与 BOOTSTRAP_RESTART_REQUIRED——必须新开会话才生效；git / worktree / .gitignore 的修复命令由编排者征得用户同意后执行，插件不跑子进程。',
  ]
}
