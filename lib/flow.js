/**
 * Pure flow layer: turn a project's `doc/racing-code.md` into a resolved flow.
 *
 * No DSH imports, no I/O, no Node APIs. Everything here is a total function over
 * strings and plain objects, so it is unit-testable and can never break system
 * prompt assembly by throwing.
 *
 * Pipeline:
 *   parseFrontMatter(text) ─┐
 *   parseMermaid(text) ─────┴─► buildFlow(parsed, opts) ─► mergeRoutes ─► checks
 *                                                            └─► renderPolicySection / renderMermaid
 *
 * `resolveFlow(text, opts)` runs the whole pipeline and is what the source layer
 * calls. The grammar and every diagnostic code are specified in
 * `doc/workflow-format.md`; this file must not drift from it.
 *
 * @module dsh-racing-code/flow
 */

/** Diagnostic levels: `error` invalidates the flow, `warn`/`info` only report. */
export const LEVELS = ['info', 'warn', 'error']

/** Defaults for the three guards, overridable per project in front matter. */
export const DEFAULTS = { maxStageRepeats: 3, maxLanes: 4, maxReviewRounds: 2 }

/** Node kinds, decided by the mermaid node shape. */
export const KINDS = ['stage', 'group', 'decision', 'user_gate']

/**
 * @typedef {object} Problem
 * @property {string} code Stable `FLOW_*` diagnostic code (see doc/workflow-format.md §9).
 * @property {'info'|'warn'|'error'} level `error` means "this file is not a usable flow".
 * @property {string} message One human sentence, including what to change.
 * @property {number} [line] 1-based line inside the mermaid block (when known).
 * @property {string} [node] Node id the problem is about (when known).
 */

/**
 * @typedef {object} Route
 * @property {string} provider
 * @property {string} model
 * @property {string} [reasoningEffort]
 */

/**
 * @typedef {object} ParsedNode
 * @property {string} id Slug node id (`^[a-z][a-z0-9-]*$`).
 * @property {'stage'|'group'|'decision'|'user_gate'} kind
 * @property {string} label Display text (the part before the optional route line).
 * @property {Route|null} route Route written on the label's second line, if any.
 * @property {string} raw Label text exactly as written (used to detect shadowed routes).
 * @property {number} line
 */

/**
 * @typedef {object} ParsedEdge
 * @property {string} from
 * @property {string} to
 * @property {string|null} when Condition label, or null for an unconditional edge.
 * @property {number} line
 */

/**
 * @typedef {object} Lane
 * @property {string} id Lane name = the first stage id on its path.
 * @property {string[]} path Stage ids from the group's successor to the join node.
 * @property {string} fanOutFrom Group node id.
 * @property {string} joinAt Join node id.
 */

/**
 * @typedef {object} Loop
 * @property {'review'|'stage'} kind `review` re-enters a parallel group; `stage` re-runs a stage.
 * @property {string} via Node the back edge leaves from.
 * @property {string} backTo Node the back edge points at.
 * @property {string} condition The edge's condition label.
 * @property {number} [maxRounds] For `review`: how many feedback→revision rounds are allowed.
 * @property {number} [maxRepeats] For `stage`: how many repeats are allowed.
 */

/**
 * @typedef {object} StageRef
 * @property {string} id
 * @property {string} label
 * @property {Route|null} route Effective route, or null when nothing configured it.
 * @property {'label'|'front-matter'|'session'|null} routeSource Where the route came from;
 *   `'session'` marks the explicit `session` sentinel in front matter (a decision to use
 *   the session model, never a warning).
 * @property {boolean} fallback True when no route is configured (delegate on the session model).
 * @property {boolean} authorized False when the allowlist does not contain the route.
 * @property {{id: string, worktree: string, branch: string, fanOutFrom: string, joinAt: string}} [lane]
 * @property {{when: string|null, to: string}[]} next
 * @property {string} [instruction] Body of the `### <id>` section, when present.
 */

/**
 * @typedef {object} Resolved
 * @property {boolean} ok True only when no `error`-level problem was found.
 * @property {string|null} entry
 * @property {{id: string, kind: string, label: string, lane?: string, next: {when: string|null, to: string}[]}[]} nodes
 * @property {StageRef[]} stages
 * @property {{at: string, lanes: string[]}[]} joins
 * @property {Loop[]} loops
 * @property {Problem[]} problems
 */

// ─────────────────────────────────── primitives ───────────────────────────────────

const ID_RE = /^[a-z][a-z0-9-]*$/
const ROUTE_RE = /^([A-Za-z0-9._-]+)\s*(?:·|\/)\s*([A-Za-z0-9._/-]+)$/
const ROUTE_LOOK_RE = /^[A-Za-z0-9._-]+(?:\s*(?:·|\/)\s*[A-Za-z0-9._/-]+){1,2}$/
const BR_RE = /<br\s*\/?>/gi
const MERMAID_RE = /```mermaid[^\n]*\n([\s\S]*?)```/g
const IGNORE_RE = /^(subgraph\b|end\b|direction\b|classDef\b|class\b|style\b|linkStyle\b|click\b)/
const EDGE = '\u0001'

/** @returns {Problem} */
function problem(code, level, message, extra = {}) {
  return { code, level, message, ...extra }
}

/** Route from `provider · model` / `provider/model` text, or null. */
function routeFromText(text) {
  const match = ROUTE_RE.exec(String(text ?? '').trim())
  return match ? { provider: match[1], model: match[2] } : null
}

function adjacency(ids, edges) {
  const map = new Map(ids.map(id => [id, []]))
  for (const edge of edges) map.get(edge.from)?.push({ edge })
  return map
}

/** Nodes reachable from `start` (including `start`). */
function reachSet(ids, edges, start) {
  const seen = new Set()
  if (!ids.includes(start)) return seen
  const adj = adjacency(ids, edges)
  const stack = [start]
  while (stack.length) {
    const node = stack.pop()
    if (seen.has(node)) continue
    seen.add(node)
    for (const { edge } of adj.get(node) ?? []) if (!seen.has(edge.to)) stack.push(edge.to)
  }
  return seen
}

/** Kahn topological order; falls back to declaration order when a cycle survives. */
function topoOrder(ids, edges) {
  const indeg = new Map(ids.map(id => [id, 0]))
  const adj = adjacency(ids, edges)
  for (const edge of edges) if (indeg.has(edge.to)) indeg.set(edge.to, indeg.get(edge.to) + 1)
  const queue = ids.filter(id => indeg.get(id) === 0)
  const order = []
  while (queue.length) {
    const node = queue.shift()
    order.push(node)
    for (const { edge } of adj.get(node) ?? []) {
      indeg.set(edge.to, indeg.get(edge.to) - 1)
      if (indeg.get(edge.to) === 0) queue.push(edge.to)
    }
  }
  return order.length === ids.length ? order : ids
}

function hasCycle(ids, edges) {
  return topoOrder(ids, edges).length !== ids.length
}

/** DFS from `entry`: reached nodes, back edges, and whether they are all conditional. */
function analyzeEntry(ids, edges, entry) {
  if (!ids.includes(entry)) return { ok: false, back: [] }
  const adj = adjacency(ids, edges)
  const color = new Map(ids.map(id => [id, 0]))
  const back = []
  const visit = node => {
    color.set(node, 1)
    for (const { edge } of adj.get(node) ?? []) {
      const seen = color.get(edge.to) ?? 0
      if (seen === 1) back.push(edge)
      else if (seen === 0) visit(edge.to)
    }
    color.set(node, 2)
  }
  visit(entry)
  const allReached = ids.every(id => color.get(id) !== 0)
  const allConditional = back.every(edge => edge.when !== null)
  const indeg = new Map(ids.map(id => [id, 0]))
  for (const edge of edges) if (!back.includes(edge)) indeg.set(edge.to, indeg.get(edge.to) + 1)
  const roots = ids.filter(id => indeg.get(id) === 0)
  return { ok: allReached && allConditional && roots.length === 1 && roots[0] === entry, back }
}

/** The earliest node (on the DAG) reachable from every start. */
function findJoin(ids, dag, starts) {
  if (starts.length === 0) return null
  const sets = starts.map(start => reachSet(ids, dag, start))
  const rank = new Map(topoOrder(ids, dag).map((id, index) => [id, index]))
  const common = ids.filter(id => sets.every(set => set.has(id)))
  if (common.length === 0) return null
  common.sort((a, b) => (rank.get(a) ?? ids.length) - (rank.get(b) ?? ids.length))
  return common[0]
}

/** Default lane directory: one hidden folder under the project root. */
const DEFAULT_LANE_DIR = '.worktrees'

/**
 * Validate the front-matter `laneDir`. A single relative directory name, plus the keyword
 * `branch` meaning "the worktree directory is the branch name". Anything else is refused.
 * @returns {{laneDir: string, problems: Problem[]}}
 */
function resolveLaneDir(value) {
  if (value === undefined) return { laneDir: DEFAULT_LANE_DIR, problems: [] }
  const text = typeof value === 'string' ? value.trim() : ''
  const invalid = text === '' || text.startsWith('~') || text.includes('..')
    || text.includes('/') || text.includes('\\')
  if (invalid) {
    return {
      laneDir: DEFAULT_LANE_DIR,
      problems: [problem('FLOW_LANE_DIR_INVALID', 'warn',
        `laneDir ${JSON.stringify(value)} 不是合法的目录名（要非空、单个相对目录、不含 ..）：已按默认 ${DEFAULT_LANE_DIR} 处理`)],
    }
  }
  return { laneDir: text, problems: [] }
}

/** Where one lane's worktree lives, relative to the project root. */
function laneWorktree(laneId, laneDir) {
  const branch = `racing/${laneId}`
  return laneDir === 'branch' ? branch : `${laneDir}/${laneId}`
}

// ─────────────────────────────── YAML subset + front matter ───────────────────────────────

function stripComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (quote) { if (char === quote) quote = null; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index)
  }
  return line
}

function typedScalar(raw) {
  const value = raw.trim()
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))))
    return value.slice(1, -1)
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^-?\d*\.\d+$/.test(value)) return Number(value)
  return value
}

const UNSUPPORTED_YAML = [
  [/^\s*-\s/, '数组'],
  [/:\s*[{[[]/, '流式写法'],
  [/:\s*[|>]\s*$/, '多行字符串'],
  [/^\s*[&*]/, '锚点'],
  [/^\s*---\s*$/, '文档分隔'],
]

/**
 * Parse the restricted YAML subset used by front matter (see doc/workflow-format.md §7.1).
 * Supported: `#` comments, `key: value`, two-space nesting, bare/quoted scalars,
 * numbers and booleans. Everything else is reported, never silently dropped.
 *
 * @param {string} text
 * @returns {{data: Record<string, unknown>, problems: Problem[]}}
 */
export function parseYamlSubset(text) {
  const data = {}
  const problems = []
  const stack = [{ indent: -1, obj: data }]
  String(text ?? '').split('\n').forEach((rawLine, index) => {
    const line = stripComment(rawLine)
    if (!line.trim()) return
    const unsupported = UNSUPPORTED_YAML.find(([re]) => re.test(line))
    if (unsupported) {
      problems.push(problem('FLOW_YAML_UNSUPPORTED', 'error',
        `第 ${index + 1} 行用了不支持的${unsupported[1]}写法：${line.trim()}`, { line: index + 1 }))
      return
    }
    const match = /^(\s*)([^\s:][^:]*?):\s*(.*)$/.exec(line)
    if (!match) {
      problems.push(problem('FLOW_YAML_UNSUPPORTED', 'error',
        `第 ${index + 1} 行不是 "键: 值"：${line.trim()}`, { line: index + 1 }))
      return
    }
    const indent = match[1].length
    const key = match[2].trim()
    const value = match[3]
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack[stack.length - 1].obj
    if (value.trim() === '') {
      const child = {}
      parent[key] = child
      stack.push({ indent, obj: child })
    } else {
      parent[key] = typedScalar(value)
    }
  })
  return { data, problems }
}

/**
 * Split a markdown document into its optional `---` front matter and the body.
 * A missing block is normal: it yields `{}` plus a `FLOW_NO_FRONT_MATTER` info problem.
 *
 * @param {string} markdown
 * @returns {{data: Record<string, unknown>, body: string, problems: Problem[]}}
 */
export function parseFrontMatter(markdown) {
  const text = String(markdown ?? '')
  const lines = text.split('\n')
  const info = () => [problem('FLOW_NO_FRONT_MATTER', 'info', '没有 front-matter，按格式版本 1 解析')]
  if (lines[0]?.trim() !== '---') return { data: {}, body: text, problems: info() }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return { data: {}, body: text, problems: info() }
  const { data, problems } = parseYamlSubset(lines.slice(1, end).join('\n'))
  return { data, body: lines.slice(end + 1).join('\n'), problems }
}

// ─────────────────────────────── mermaid subset ───────────────────────────────

/**
 * Split a stage label into display text and an optional route.
 * The second `<br/>`-separated line counts as a route only when it matches
 * `^[A-Za-z0-9._/-]+\s*[·/]\s*[A-Za-z0-9._/-]+$`; anything else stays display text.
 *
 * @param {string} raw Label text as written between the node's brackets.
 * @returns {{label: string, route: Route|null}}
 */
export function parseNodeLabel(raw) {
  const text = String(raw ?? '')
  const parts = text.split(BR_RE).map(part => part.trim())
  if (parts.length >= 2) {
    const route = routeFromText(parts[1])
    if (route) {
      const label = [parts[0], ...parts.slice(2)].filter(Boolean).join(' ').trim()
      return { label, route }
    }
  }
  return { label: text.replace(BR_RE, ' ').replace(/\s+/g, ' ').trim(), route: null }
}

/** One node segment → its declared id, registering the node on first sight. */
function declareNode(segment, line, nodes, declared, problems) {
  const text = String(segment ?? '').trim()
  if (!text) {
    problems.push(problem('FLOW_UNPARSABLE_EDGE', 'error', `第 ${line} 行有一个空节点`, { line }))
    return null
  }
  const match = /^([^\s[({]+)\s*([\s\S]*)$/.exec(text)
  if (!match) {
    problems.push(problem('FLOW_UNPARSABLE_NODE', 'error', `第 ${line} 行认不出的节点写法：${text}`, { line }))
    return null
  }
  const id = match[1]
  const shape = match[2].trim()
  let kind = 'stage'
  if (/^\(\s*\[/.test(shape)) kind = 'user_gate'
  else if (shape.startsWith('{{')) kind = 'group'
  else if (shape.startsWith('{')) kind = 'decision'
  if (!ID_RE.test(id)) {
    problems.push(problem('FLOW_BAD_NODE_ID', 'error',
      `节点 id "${id}" 不是 slug（小写字母开头，只含小写字母/数字/连字符）`, { line, node: id }))
  }
  let labelText = null
  if (shape) {
    if (/^\(/.test(shape) && !/^\(\s*\[/.test(shape)) {
      problems.push(problem('FLOW_ROUND_NODE_DEPRECATED', 'info',
        `第 ${line} 行用了圆角节点 ${id}(…)：建议改写成 ${id}[…] 或 ${id}([…])，以免与用户关口混淆`, { line, node: id }))
    }
    labelText = unwrapShape(shape)
    if (labelText === null) {
      problems.push(problem('FLOW_UNPARSABLE_NODE', 'error',
        `第 ${line} 行的节点 ${id} 写法不对（形状没闭合，或后面还有多余文本）：${text}`, { line, node: id }))
    }
  }
  const existing = declared.get(id)
  if (existing) {
    if (labelText !== null && existing.declaredLabel) {
      problems.push(problem('FLOW_DUPLICATE_NODE', 'error',
        `节点 ${id} 被声明了两次（第二次只写 id 即可，不带 ["标签"]）`, { line, node: id }))
    } else if (labelText !== null) {
      const { label, route } = parseNodeLabel(labelText)
      existing.kind = kind
      existing.label = label
      existing.route = route
      existing.raw = labelText
      existing.declaredLabel = true
    }
    return id
  }
  const { label, route } = labelText === null ? { label: id, route: null } : parseNodeLabel(labelText)
  const node = { id, kind, label, route, raw: labelText ?? id, line, declaredLabel: labelText !== null }
  nodes.push(node)
  declared.set(id, node)
  return id
}

const SHAPE_PAIRS = [['([', '])'], ['[[', ']]'], ['{{', '}}'], ['[', ']'], ['{', '}'], ['(', ')']]

/** Unwrap one node shape; `null` when the text is not exactly one shape (leftover junk). */
function unwrapShape(shape) {
  const text = shape.trim()
  for (const [open, close] of SHAPE_PAIRS) {
    if (text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, text.length - close.length).trim().replace(/^["']/, '').replace(/["']$/, '').trim()
    }
  }
  return null
}

/** `a -- "x" --> b --> c` → ['a', 'x', 'b', '', 'c'] */
function splitChain(line) {
  const normalized = line
    .replace(/--\s*"([^"]*)"\s*-->/g, (_, condition) => `${EDGE}${condition}${EDGE}`)
    .replace(/-->\s*\|([^|]*)\|/g, (_, condition) => `${EDGE}${condition}${EDGE}`)
    .replace(/-\.->|-->|==>/g, `${EDGE}${EDGE}`)
  return normalized.split(EDGE).map(part => part.trim())
}

/**
 * Extract the first ```mermaid block and parse the supported subset: four node shapes,
 * `-->`/`-.->`/`==>` edges, `-- "condition" -->` and `-->|condition|` labels, the
 * `%% entry: <id>` directive, and the documented ignore list.
 *
 * @param {string} markdown
 * @returns {{nodes: ParsedNode[], edges: ParsedEdge[], entry: string|null, problems: Problem[]}}
 */
export function parseMermaid(markdown) {
  const blocks = [...String(markdown ?? '').matchAll(MERMAID_RE)].map(match => match[1])
  if (blocks.length === 0) {
    return {
      nodes: [], edges: [], entry: null,
      problems: [problem('FLOW_FENCE_MISSING', 'error', '没有 ```mermaid 代码块：这个文件没有声明流程')],
    }
  }
  const problems = []
  if (blocks.length > 1)
    problems.push(problem('FLOW_MULTIPLE_FENCES', 'warn', `有 ${blocks.length} 个 mermaid 代码块，只用第一个`))

  const lines = blocks[0].split('\n')
  const typeIndex = lines.findIndex(line => line.trim() && !line.trim().startsWith('%%'))
  if (typeIndex < 0 || !/^(flowchart|graph)\b/.test(lines[typeIndex].trim())) {
    problems.push(problem('FLOW_UNSUPPORTED_DIAGRAM', 'error',
      `只支持 flowchart/graph 图，实际是：${(lines[typeIndex] ?? '').trim() || '(空)'}`, { line: typeIndex + 1 }))
  }

  const nodes = []
  const edges = []
  const declared = new Map()
  let entry = null
  lines.forEach((raw, index) => {
    const line = index + 1
    const text = raw.trim()
    if (!text) return
    const directive = /^%%\s*entry:\s*(\S+)\s*$/.exec(text)
    if (directive) { if (entry === null) entry = directive[1]; return }
    if (text.startsWith('%%')) return
    if (index === typeIndex || IGNORE_RE.test(text)) return
    if (text.includes('&')) {
      problems.push(problem('FLOW_UNPARSABLE_EDGE', 'error', `第 ${line} 行用了 & 合并，不支持：${text}`, { line }))
      return
    }
    const parts = splitChain(text)
    if (parts.length === 0) return
    const ids = []
    for (let i = 0; i < parts.length; i += 2) ids.push(declareNode(parts[i], line, nodes, declared, problems))
    for (let i = 1; i < parts.length; i += 2) {
      const from = ids[(i - 1) / 2]
      const to = ids[(i + 1) / 2]
      if (from && to) edges.push({ from, to, when: parts[i] === '' ? null : parts[i], line })
    }
  })
  return { nodes, edges, entry, problems }
}

// ─────────────────────────────── graph rules ───────────────────────────────

/**
 * Decide the flow's entry (doc/workflow-format.md §4.1): a node is a legal entry when
 * a DFS from it reaches every node, every back edge it finds is conditional, and it is
 * the only root of the remaining DAG. Exactly one legal entry is required — more than
 * one needs the `%% entry:` directive.
 *
 * @param {ParsedNode[]} nodes
 * @param {ParsedEdge[]} edges
 * @param {string|null} declared Value of `%% entry:` when present.
 * @returns {{entry: string|null, candidates: string[], problems: Problem[]}}
 */
export function resolveEntry(nodes, edges, declared) {
  const ids = nodes.map(node => node.id)
  const candidates = ids.filter(id => analyzeEntry(ids, edges, id).ok)
  if (declared) {
    if (!ids.includes(declared)) {
      return {
        entry: null, candidates,
        problems: [problem('FLOW_BAD_ENTRY', 'error', `%% entry: ${declared} 指的不是图里的节点`)],
      }
    }
    if (!candidates.includes(declared)) {
      return {
        entry: declared, candidates,
        problems: [problem('FLOW_BAD_ENTRY', 'error',
          `%% entry: ${declared} 不是合法入口：从它出发走不到全图，或者它只在环里（合法候选：${candidates.join(', ') || '无'}）`)],
      }
    }
    return { entry: declared, candidates, problems: [] }
  }
  if (candidates.length === 1) return { entry: candidates[0], candidates, problems: [] }
  if (candidates.length === 0) {
    return {
      entry: null, candidates,
      problems: [problem('FLOW_NO_ENTRY', 'error',
        '没有任何合法入口：没有回边时通常是缺一个起点；有两条互不相干的入口线请用一个判定节点合流')],
    }
  }
  return {
    entry: null, candidates,
    problems: [problem('FLOW_AMBIGUOUS_ENTRY', 'error',
      `有 ${candidates.length} 个合法入口（${candidates.join(', ')}）：请在 mermaid 块里加一行 %% entry: <节点 id>`)],
  }
}

/**
 * Check each node's out-edges against its kind (doc/workflow-format.md §4):
 * stages may sequence or branch; only a group may fan out; decisions and user gates
 * must label their edges.
 *
 * @param {ParsedNode[]} nodes
 * @param {ParsedEdge[]} edges
 * @returns {{problems: Problem[]}}
 */
export function classifyEdges(nodes, edges) {
  const problems = []
  for (const node of nodes) {
    const out = edges.filter(edge => edge.from === node.id)
    const labeled = out.filter(edge => edge.when !== null)
    const unconditional = out.filter(edge => edge.when === null)
    if (node.kind === 'stage') {
      if (unconditional.length >= 2) {
        problems.push(labeled.length > 0
          ? problem('FLOW_AMBIGUOUS_FANOUT', 'error',
            `阶段 ${node.id} 同时有 ${unconditional.length} 条无条件出边和条件出边：分不清是并行还是分支；并行请用一个 {{并行组}} 节点`, { node: node.id })
          : problem('FLOW_STAGE_FANOUT_NOT_GROUP', 'error',
            `阶段 ${node.id} 有 ${unconditional.length} 条无条件出边：并行必须写成 {{并行组}} 节点`, { node: node.id }))
      }
    } else if (node.kind === 'group') {
      if (labeled.length > 0)
        problems.push(problem('FLOW_GROUP_LABELED_EDGE', 'error', `并行组 ${node.id} 的出边不能带条件（组只负责发车）`, { node: node.id }))
      if (unconditional.length < 2)
        problems.push(problem('FLOW_GROUP_NEEDS_TWO_LANES', 'error', `并行组 ${node.id} 只有 ${unconditional.length} 条出边，至少要 2 条赛道`, { node: node.id }))
    } else {
      const what = node.kind === 'user_gate' ? '用户关口' : '判定'
      if (out.length === 0) {
        problems.push(problem('FLOW_DECISION_DEAD_END', 'error', `${what} ${node.id} 没有出边`, { node: node.id }))
      } else if (node.kind === 'user_gate' ? unconditional.length > 0 : unconditional.length > 1) {
        problems.push(problem('FLOW_DECISION_UNLABELED_EDGE', 'error',
          `${what} ${node.id} 的出边必须写明条件（条件文字就是给用户的选项）`, { node: node.id }))
      }
    }
  }
  return { problems }
}

/**
 * Mark back edges by DFS from the entry, and report unconditional ones.
 *
 * @param {ParsedNode[]} nodes
 * @param {ParsedEdge[]} edges
 * @param {string} entry
 * @returns {{back: ParsedEdge[], problems: Problem[]}}
 */
export function classifyBackEdges(nodes, edges, entry) {
  const ids = nodes.map(node => node.id)
  if (!ids.includes(entry)) return { back: [], problems: [] }
  const { back } = analyzeEntry(ids, edges, entry)
  const problems = back
    .filter(edge => edge.when === null)
    .map(edge => problem('FLOW_UNLABELED_BACK_EDGE', 'error',
      `回边 ${edge.from} → ${edge.to} 没写条件：无条件回边等于死循环`, { node: edge.from }))
  if (hasCycle(ids, edges.filter(edge => !back.includes(edge))))
    problems.push(problem('FLOW_CYCLE_WITHOUT_ORDER', 'error', '图里有一个不是回边构成的环，无法判断先后顺序'))
  return { back, problems }
}

/**
 * Turn one parallel group into lanes: a lane is the straight path from one of the
 * group's successors to the join node (the earliest node reachable from every lane,
 * measured on the DAG without back edges).
 *
 * @param {ParsedNode[]} nodes
 * @param {ParsedEdge[]} edges
 * @param {ParsedNode} group
 * @param {{maxLanes?: number, back?: ParsedEdge[]}} [opts]
 * @returns {{lanes: Lane[], join: string|null, problems: Problem[]}}
 */
export function buildLanes(nodes, edges, group, opts = {}) {
  const problems = []
  const ids = nodes.map(node => node.id)
  const kindOf = new Map(nodes.map(node => [node.id, node.kind]))
  const maxLanes = opts.maxLanes ?? DEFAULTS.maxLanes
  const back = opts.back ?? []
  const dag = edges.filter(edge => !back.includes(edge))
  const successors = dag.filter(edge => edge.from === group.id)
  if (successors.length > maxLanes)
    problems.push(problem('FLOW_TOO_MANY_LANES', 'error', `并行组 ${group.id} 有 ${successors.length} 条赛道，超过上限 ${maxLanes}`, { node: group.id }))
  for (const edge of successors) {
    if (kindOf.get(edge.to) === 'group')
      problems.push(problem('FLOW_NESTED_FANOUT', 'error', `并行组 ${group.id} 的赛道 ${edge.to} 又是一个并行组：v1 不支持嵌套`, { node: edge.to }))
  }
  const join = findJoin(ids, dag, successors.map(edge => edge.to))
  if (!join) {
    problems.push(problem('FLOW_NO_JOIN', 'error',
      `并行组 ${group.id} 的各条赛道没有共同汇合点：请让它们都走到同一个节点（通常是 CR 评审）`, { node: group.id }))
    return { lanes: [], join: null, problems }
  }
  const lanes = []
  for (const edge of successors) {
    const path = []
    let cursor = edge.to
    let guard = 0
    while (cursor !== join && guard++ <= ids.length) {
      const kind = kindOf.get(cursor)
      if (kind === 'group') {
        problems.push(problem('FLOW_NESTED_FANOUT', 'error', `赛道 ${edge.to} 内部又出现并行组 ${cursor}`, { node: cursor }))
        break
      }
      if (kind === 'decision' || kind === 'user_gate') {
        problems.push(problem('FLOW_BRANCH_INSIDE_LANE', 'error',
          `赛道 ${edge.to} 内部有${kind === 'user_gate' ? '用户关口' : '判定'} ${cursor}：赛道必须是直线`, { node: cursor }))
        break
      }
      path.push(cursor)
      const out = dag.filter(item => item.from === cursor)
      if (out.length === 0) {
        problems.push(problem('FLOW_NO_JOIN', 'error', `赛道 ${edge.to} 走到 ${cursor} 就停了，没有到达汇合点 ${join}`, { node: cursor }))
        break
      }
      if (out.length > 1) {
        problems.push(problem('FLOW_BRANCH_INSIDE_LANE', 'error', `赛道 ${edge.to} 在 ${cursor} 分叉了：赛道必须是直线`, { node: cursor }))
        break
      }
      cursor = out[0].to
    }
    if (path.length > 0) lanes.push({ id: path[0], path, fanOutFrom: group.id, joinAt: join })
  }
  return { lanes, join, problems }
}

/**
 * Turn back edges into loops: a back edge into a group is a review round, a back edge
 * into a stage is a repeat. Carries the guard limits from `opts`.
 *
 * @param {ParsedNode[]} nodes
 * @param {ParsedEdge[]} edges
 * @param {ParsedEdge[]} back
 * @param {{maxStageRepeats?: number, maxReviewRounds?: number}} [opts]
 * @returns {{loops: Loop[], problems: Problem[]}}
 */
export function buildLoops(nodes, edges, back, opts = {}) {
  const problems = []
  const loops = []
  const ids = nodes.map(node => node.id)
  const kindOf = new Map(nodes.map(node => [node.id, node.kind]))
  const dag = edges.filter(edge => !back.includes(edge))
  for (const edge of back) {
    const kind = kindOf.get(edge.to)
    if (kind === 'group') {
      const successors = dag.filter(item => item.from === edge.to).map(item => item.to)
      const join = findJoin(ids, dag, successors)
      if (!join || kindOf.get(join) !== 'stage') {
        problems.push(problem('FLOW_LOOP_WITHOUT_REVIEW', 'warn',
          `回边指回并行组 ${edge.to}，但这个组之后没有评审阶段：重新开跑前没人横向比较`, { node: edge.to }))
      }
      loops.push({
        kind: 'review', via: edge.from, backTo: edge.to, condition: edge.when,
        maxRounds: opts.maxReviewRounds ?? DEFAULTS.maxReviewRounds,
      })
    } else if (kind === 'stage') {
      loops.push({
        kind: 'stage', via: edge.from, backTo: edge.to, condition: edge.when,
        maxRepeats: opts.maxStageRepeats ?? DEFAULTS.maxStageRepeats,
      })
    } else {
      problems.push(problem('FLOW_BACK_EDGE_TARGET', 'error',
        `回边只能指向阶段或并行组：${edge.from} → ${edge.to} 指向了${kind === 'user_gate' ? '用户关口' : kind === 'decision' ? '判定' : '未知节点'}`,
        { node: edge.from }))
    }
  }
  return { loops, problems }
}

// ─────────────────────────────── assembly ───────────────────────────────

function definedGuards(opts = {}) {
  const guards = {}
  for (const key of Object.keys(DEFAULTS)) {
    const value = opts[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) guards[key] = Math.floor(value)
  }
  return guards
}

/**
 * Assemble a parsed diagram into a resolved flow: entry, node list, executable stages
 * (with lanes), joins, loops and every `error`-level problem. `ok` is false when any
 * error was found; callers must then not inject a flow.
 *
 * @param {{nodes: ParsedNode[], edges: ParsedEdge[], entry: string|null, problems: Problem[]}} parsed
 * @param {{maxStageRepeats?: number, maxLanes?: number, maxReviewRounds?: number,
 *          laneDir?: string}} [opts] `laneDir` is a directory name, or `branch`.
 * @returns {Resolved}
 */
export function buildFlow(parsed, opts = {}) {
  const guards = { ...DEFAULTS, ...definedGuards(opts) }
  const nodes = parsed.nodes ?? []
  const edges = parsed.edges ?? []
  const problems = [...(parsed.problems ?? [])]
  const ids = nodes.map(node => node.id)
  const nextOf = id => edges.filter(edge => edge.from === id).map(edge => ({ when: edge.when, to: edge.to }))
  const outNodes = nodes.map(node => ({
    id: node.id, kind: node.kind, label: node.label, next: nextOf(node.id),
  }))

  let entry = null
  let stages = []
  let joins = []
  let loops = []

  if (!problems.some(item => item.level === 'error')) {
    problems.push(...classifyEdges(nodes, edges).problems)
    const resolvedEntry = resolveEntry(nodes, edges, parsed.entry ?? null)
    problems.push(...resolvedEntry.problems)
    entry = resolvedEntry.entry
    if (entry) {
      const unreachable = ids.filter(id => !reachSet(ids, edges, entry).has(id))
      if (unreachable.length > 0)
        problems.push(problem('FLOW_UNREACHABLE_STAGE', 'error', `从入口 ${entry} 走不到：${unreachable.join(', ')}`))
      const { back, problems: backProblems } = classifyBackEdges(nodes, edges, entry)
      problems.push(...backProblems)
      if (!problems.some(item => item.level === 'error')) {
        const laneDir = opts.laneDir ?? DEFAULT_LANE_DIR
        const laneRefs = new Map()
        for (const group of nodes.filter(node => node.kind === 'group')) {
          const built = buildLanes(nodes, edges, group, { maxLanes: guards.maxLanes, back })
          problems.push(...built.problems)
          if (built.join && built.lanes.length > 0) {
            joins.push({ at: built.join, lanes: built.lanes.map(lane => lane.id) })
            for (const lane of built.lanes) {
              for (const id of lane.path) {
                laneRefs.set(id, {
                  id: lane.id, worktree: laneWorktree(lane.id, laneDir), branch: `racing/${lane.id}`,
                  fanOutFrom: lane.fanOutFrom, joinAt: lane.joinAt,
                })
              }
            }
          }
        }
        const built = buildLoops(nodes, edges, back, guards)
        problems.push(...built.problems)
        loops = built.loops
        stages = nodes.filter(node => node.kind === 'stage').map(node => ({
          id: node.id,
          label: node.label,
          route: node.route,
          routeSource: node.route ? 'label' : null,
          fallback: !node.route,
          authorized: true,
          ...(laneRefs.has(node.id) ? { lane: laneRefs.get(node.id) } : {}),
          next: nextOf(node.id),
        }))
      }
    }
  }

  for (const node of outNodes) if (node.kind === 'stage') {
    const lane = stages.find(stage => stage.id === node.id)?.lane
    if (lane) node.lane = lane.id
  }

  return { ok: !problems.some(item => item.level === 'error'), entry, nodes: outNodes, stages, joins, loops, problems }
}

/**
 * Route from a front-matter value (string shorthand or `{provider, model, …}`). The bare
 * string `session` is the explicit "use the current session model" sentinel; it comes back
 * as `{ session: true }` so {@link mergeRoutes} can tell a decision from an absence.
 */
function routeFromValue(raw) {
  if (typeof raw === 'string' && raw.trim() === 'session') return { session: true }
  if (typeof raw === 'string') return routeFromText(raw)
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
    const model = typeof raw.model === 'string' ? raw.model.trim() : ''
    if (!provider || !model) return null
    const route = { provider, model }
    if (typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.trim()) route.reasoningEffort = raw.reasoningEffort.trim()
    return route
  }
  return null
}

/**
 * True when the stage runs inside a parallel lane. A lane always delegates, whatever its
 * route: `session`/missing means "the child inherits the current session model", never
 * "run it here". There is deliberately no stage-name exception — a `commit` stage delegates
 * only when the configuration declares a `provider/model` for it, like every other stage.
 *
 * @param {StageRef} stage
 * @returns {boolean}
 */
function isLaneStage(stage) {
  return Boolean(stage?.lane)
}

/**
 * Fill in each stage's route: label wins, then front matter, then the session route,
 * then nothing (`fallback: true`, meaning "delegate without provider/model"). A front-matter
 * value of the bare string `session` is the explicit sentinel: `routeSource: 'session'`,
 * no `FLOW_ROUTE_MISSING` warning (doc/bootstrap.md §3.3).
 * Returns fresh stage objects and never mutates its input, so the same resolved flow
 * can be merged repeatedly (different allowlists, different session routes).
 *
 * @param {StageRef[]} stages
 * @param {Record<string, unknown>} models Front matter `models:` map.
 * @param {Route|null} sessionRoute Route of the session that will delegate.
 * @returns {{stages: StageRef[], problems: Problem[]}}
 */
export function mergeRoutes(stages, models = {}, sessionRoute = null) {
  const problems = []
  const table = models && typeof models === 'object' ? models : {}
  const known = new Set(stages.map(stage => stage.id))
  // With no usable stage list (the flow did not resolve) an unknown-key warning for every
  // entry would drown the single real error, so the check only runs on a resolved flow.
  if (known.size > 0) {
    for (const key of Object.keys(table)) {
      if (!known.has(key))
        problems.push(problem('FLOW_MODEL_UNKNOWN_STAGE', 'warn', `模型表里的 ${key} 在图里没有对应阶段，已忽略`, { node: key }))
    }
  }
  const out = stages.map(stage => {    const merged = { ...stage }
    if (merged.route) {
      merged.routeSource = 'label'
      merged.fallback = false
      return merged
    }
    if (table[merged.id] !== undefined) {
      const route = routeFromValue(table[merged.id])
      if (route && route.session === true) {
        // Explicit `session` (decision 3): a decision, not a missing route — never warned,
        // never unauthorized (the session model is not an allowlist entry).
        merged.route = sessionRoute ?? null
        merged.routeSource = 'session'
        merged.fallback = true
        return merged
      }
      if (route) {
        merged.route = route
        merged.routeSource = 'front-matter'
        merged.fallback = false
        return merged
      }
      problems.push(problem('FLOW_ROUTE_MALFORMED', 'warn',
        `front-matter 里 ${merged.id} 的路由写法不对（要 "provider/model" 或 {provider, model}），已忽略`, { node: merged.id }))
    }
    merged.route = sessionRoute ?? null
    merged.routeSource = null
    merged.fallback = true
    problems.push(problem('FLOW_ROUTE_MISSING', 'warn', isLaneStage(merged)
      ? `阶段 ${merged.id} 没有配置路由：委派时用当前会话模型${sessionRoute ? `（${sessionRoute.provider} · ${sessionRoute.model}）` : ''}；要固定就在标签第二行写 provider · model`
      : `阶段 ${merged.id} 没有配置路由：将在当前会话直接执行；要固定就在标签第二行写 provider · model`,
      { node: merged.id }))
    return merged
  })
  return { stages: out, problems }
}

/**
 * Mark routes the subagent allowlist does not contain. A missing allowlist (service
 * unavailable) skips the check instead of reporting everything as unauthorized.
 *
 * @param {StageRef[]} stages
 * @param {{provider: string, model: string}[]|null} allowedModels
 * @returns {{problems: Problem[]}}
 */
export function checkAuthorized(stages, allowedModels) {
  const problems = []
  if (!Array.isArray(allowedModels)) {
    for (const stage of stages) if (!stage.fallback) stage.authorized = true
    return { problems }
  }
  for (const stage of stages) {
    if (stage.fallback || !stage.route) { stage.authorized = true; continue }
    const allowed = allowedModels.some(entry => entry && entry.provider === stage.route.provider && entry.model === stage.route.model)
    stage.authorized = allowed
    if (!allowed) {
      problems.push(problem('FLOW_ROUTE_NOT_AUTHORIZED', 'warn',
        `${stage.id} 的路由 ${stage.route.provider} · ${stage.route.model} 不在子代理白名单里：请先在 Settings → Plugins → Subagent delegation 里加上它`,
        { node: stage.id }))
    }
  }
  return { problems }
}

/**
 * Warn when the CR stage reuses a lane's model (self-preference bias). The CR stage is
 * the join target that a review loop passes through; lane models come from the lanes.
 *
 * @param {StageRef[]} stages
 * @param {Lane[]} lanes
 * @returns {{problems: Problem[]}}
 */
export function checkReviewer(stages, lanes) {
  const problems = []
  const byIdMap = new Map(stages.map(stage => [stage.id, stage]))
  const reviewerIds = [...new Set((lanes ?? []).map(lane => lane.joinAt).filter(Boolean))]
  for (const reviewerId of reviewerIds) {
    const reviewer = byIdMap.get(reviewerId)
    if (!reviewer?.route) continue
    for (const lane of lanes ?? []) {
      if (lane.joinAt !== reviewerId) continue
      const laneStage = byIdMap.get(lane.id)
      if (!laneStage?.route) continue
      if (laneStage.route.provider === reviewer.route.provider && laneStage.route.model === reviewer.route.model) {
        problems.push(problem('FLOW_CR_MODEL_REUSED', 'warn',
          `评审阶段 ${reviewerId} 与赛道 ${lane.id} 用了同一个模型 ${reviewer.route.provider} · ${reviewer.route.model}：自评会有偏好，建议换第三条路由`,
          { node: reviewerId }))
      }
    }
  }
  return { problems }
}

/**
 * Warn when a label looks like a route but was not parsed as one while the effective
 * route comes from somewhere else — the signature of pasting a rendered diagram back.
 *
 * @param {ParsedNode[]} nodes
 * @param {StageRef[]} stages
 * @returns {{problems: Problem[]}}
 */
export function checkLabelShadowing(nodes, stages) {
  const problems = []
  const byIdMap = new Map(stages.map(stage => [stage.id, stage]))
  for (const node of nodes) {
    if (node.kind !== 'stage' || node.route) continue
    const parts = String(node.raw ?? '').split(BR_RE).map(part => part.trim())
    if (parts.length < 2 || !ROUTE_LOOK_RE.test(parts[1])) continue
    const stage = byIdMap.get(node.id)
    if (stage?.routeSource === 'front-matter') {
      problems.push(problem('FLOW_LABEL_ROUTE_SHADOWED', 'warn',
        `${node.id} 的标签上写着 "${parts[1]}"，但这不是合法的路由写法，实际生效的是 front-matter 里的 ${stage.route.provider} · ${stage.route.model}`,
        { node: node.id }))
    }
  }
  return { problems }
}

/**
 * Attach each stage's prompt skeleton: the body of a `### <id>` (or `##`/`####`) section.
 *
 * @param {StageRef[]} stages
 * @param {string} markdown
 * @returns {{stages: StageRef[]}}
 */
export function attachInstructions(stages, markdown) {
  const wanted = new Set(stages.map(stage => stage.id))
  const found = new Map()
  const lines = String(markdown ?? '').split('\n')
  let current = null
  let buffer = []
  const flush = () => {
    if (current && buffer.join('\n').trim()) found.set(current, buffer.join('\n').trim())
    buffer = []
  }
  for (const line of lines) {
    const heading = /^#{1,4}\s+(\S+)\s*$/.exec(line.trim())
    if (heading) {
      flush()
      current = wanted.has(heading[1]) ? heading[1] : null
      continue
    }
    if (current) buffer.push(line)
  }
  flush()
  for (const stage of stages) if (found.has(stage.id)) stage.instruction = found.get(stage.id)
  return { stages }
}

// ─────────────────────────────── lane subagent naming ───────────────────────────────

/** A stage node id's trailing `-<single letter>` ordinal, e.g. the `-a` of `implement-a`. */
const LANE_ORDINAL_RE = /-([a-z])$/

/**
 * The display name (`subagent`'s `description`) of the subagent that runs one stage node inside
 * a lane: `<node stem>-<model>`, a compact slug with no provider and no separator
 * (doc/workflow-format.md §5.3). Naming is per node, never per lane: a lane chaining two stages
 * yields two names, each computed from its own node id.
 *
 * - `node stem` = the node id without a trailing `-<single letter>` ordinal (`implement-a` →
 *   `implement`); an id without such an ordinal is used as is (`pipe-a2` → `pipe-a2`);
 *   if stripping would leave an empty stem, the id is used as is.
 * - `model` = the node's effective route model; a node that delegates on the session model
 *   (missing route, `session`, or a route without a model) gets the literal `session`.
 *
 * @param {string} nodeId Id of the stage node the subagent runs.
 * @param {{provider?: string, model?: string}|null|undefined} route Effective route.
 * @returns {string} e.g. `<node stem>-<model>`, `<node stem>-session`.
 */
export function laneAgentName(nodeId, route) {
  const id = typeof nodeId === 'string' ? nodeId : String(nodeId ?? '')
  const stripped = id.replace(LANE_ORDINAL_RE, '')
  // An id that is only an ordinal (`-a`) would strip to nothing: the id itself is the stem.
  const stem = stripped === '' ? id : stripped
  const model = route && typeof route.model === 'string' && route.model.trim() !== ''
    ? route.model.trim()
    : 'session'
  return `${stem}-${model}`
}

/**
 * The `子代理显示名` line of `flow_stages.details`: `<node-id>=<name>` for every stage inside a
 * lane, in declaration order, one entry per node (never aggregated per lane), separated by two
 * spaces. Each name is computed from that node's own id and route, so a chained lane yields one
 * name per stage and never a duplicate id. Returns the empty string when the flow has no lane
 * stage. Pure function of the stages: both races must render the identical line.
 *
 * @param {StageRef[]} stages
 * @returns {string} e.g. `子代理显示名：<node-id>=<node stem>-<model>  …`
 */
export function laneAgentNameLine(stages) {
  const list = Array.isArray(stages) ? stages : []
  const seen = new Set()
  const entries = []
  for (const stage of list) {
    if (!isLaneStage(stage) || seen.has(stage.id)) continue
    seen.add(stage.id)
    entries.push(`${stage.id}=${laneAgentName(stage.id, stage.route)}`)
  }
  return entries.length === 0 ? '' : `子代理显示名：${entries.join('  ')}`
}

// ─────────────────────────────── rendering ───────────────────────────────

const RULES = [
  '规则：顺序阶段按声明分流——模型表里声明了 provider/model 的阶段用官方 subagent 前台委派一次（显式传 provider/model）；没声明（session 或缺键）的阶段在当前会话直接执行（不委派子代理）；lane 永远委派（lane 选 session = 子代理继承当前会话模型）。没有按阶段命名的例外。委派时子代理看不到本会话，提示词必须自包含。',
  '并行组：同一条消息里同时发起所有赛道（后台运行），每条赛道在自己的 worktree 里工作（绝对路径见 flow_stages 的 worktree 字段，分支 racing/<lane-id>），提示词写死该路径；每个赛道阶段节点的子代理 description 用「子代理显示名」（<节点词干>-<model>：词干=该节点自身 id 去掉尾部单个字母的序号段，未声明路由的节点用 session 后缀），照抄 flow_stages 的「子代理显示名」行、逐节点命名不按 lane 聚合；汇合点要等所有赛道结束后才开始；落败赛道的 worktree 不得擅自删除。',
  '复盘轮：评审阶段的问题按赛道切分，用 send_message 发回该赛道原来的子代理，在原 worktree/原分支上改并提交；改到每条赛道都没有阻塞问题的那一轮才给胜者；超过轮次上限就停下问用户。',
  '判定与用户关口同语义：执行方先给建议与依据，再用 ask_user_question 让用户下判断（选项就是图上那两条边的文字）；提问前先把完整材料发出来（问题清单逐条、diff 摘要、建议），等待给足（≥10 分钟），不许只给统计数字；同一阶段重复超过上限时停下问用户。',
]

function diagramLines(resolved) {
  /** `id(label)` for stages (labels carry meaning), plain id when they are identical. */
  const named = node => (node.label && node.label !== node.id ? `${node.id}(${node.label})` : node.id)
  const lines = []
  for (const node of resolved.nodes) {
    if (node.kind === 'group') {
      lines.push(`[${node.id}: ${(node.next ?? []).map(next => next.to).join(' ∥ ')}]`)
      continue
    }
    const targets = (node.next ?? []).map(next => next.when === null ? next.to : `--${next.when}--> ${next.to}`)
    const head = node.kind === 'decision' ? `${node.id}{${node.label}}`
      : node.kind === 'user_gate' ? `(${named(node)})`
        : named(node)
    lines.push(`${head} → ${targets.length ? targets.join(' ; ') : '（终点）'}`)
  }
  return lines
}

/**
 * One stage's entry in the `路由：` line. An explicit route shows `provider·model`; a
 * `session`/missing route instead says where the stage actually runs — "in this session"
 * for a plain stage, "delegate on the session model" for a lane or `commit` (which always
 * delegate), so the split is readable without reading the rules paragraph.
 *
 * @param {StageRef} stage
 * @returns {string}
 */
function routeLabel(stage) {
  if (stage.route && !stage.fallback)
    return `${stage.route.provider}·${stage.route.model}${stage.authorized ? '' : '（⚠ 未授权）'}`
  return isLaneStage(stage) ? '（用当前会话模型委派）' : '（在当前会话直接执行）'
}

/**
 * Render the compact system-prompt section: file path, one-line diagram, per-stage
 * routes, execution rules and review-round rules. Must never throw and never return
 * an empty string for a resolved flow.
 *
 * @param {Resolved & {file?: string}} resolved
 * @returns {string}
 */
export function renderPolicySection(resolved) {
  const problems = resolved?.problems ?? []
  if (!resolved || !Array.isArray(resolved.nodes) || resolved.nodes.length === 0) {
    return ['racing-code: 本项目没有可用的开发流程（doc/racing-code.md 缺失或不可解析）。', ...diagnose(problems)].join('\n')
  }
  if (resolved.ok === false) {
    return [
      'racing-code: 流程文件解析失败，本次未启用流程（改好文件后下一个模型步生效）：',
      ...diagnose(problems).map(line => `  - ${line}`),
    ].join('\n')
  }
  const out = [`项目流程：${resolved.file ?? '(项目内的流程文件)'}`]
  out.push(...diagramLines(resolved))
  out.push(`路由：${resolved.stages
    .map(stage => `${stage.id}=${routeLabel(stage)}`)
    .join('  ')}`)
  if (resolved.loops?.length) {
    out.push(`回边与上限：${resolved.loops
      .map(loop => loop.kind === 'review'
        ? `评审轮 ${loop.via}→${loop.backTo}（最多 ${loop.maxRounds} 轮）`
        : `重跑 ${loop.via}→${loop.backTo}（最多 ${loop.maxRepeats} 次）`)
      .join('；')}`)
  }
  out.push(...RULES)
  return out.join('\n')
}

function escapeLabel(text) {
  return String(text ?? '').replace(/"/g, "'").trim()
}

/**
 * Render the "mermaid diagram with models": effective routes are written into the node
 * labels, unconfigured stages are marked, unauthorized routes are flagged. The result is
 * a rendering, never a source: the parser ignores models it finds in labels.
 *
 * @param {Resolved & {file?: string}} resolved
 * @returns {string}
 */
export function renderMermaid(resolved) {
  const lines = ['flowchart TD']
  if (resolved.entry) lines.push(`  %% entry: ${resolved.entry}`)
  const stageById = new Map((resolved.stages ?? []).map(stage => [stage.id, stage]))
  for (const node of resolved.nodes ?? []) {
    const label = escapeLabel(node.label)
    if (node.kind === 'group') { lines.push(`  ${node.id}{{"${label}"}}`); continue }
    if (node.kind === 'decision') { lines.push(`  ${node.id}{"${label}"}`); continue }
    if (node.kind === 'user_gate') { lines.push(`  ${node.id}(["${label}"])`); continue }
    const stage = stageById.get(node.id)
    const markers = `${stage?.fallback ? (isLaneStage(stage) ? '（用当前会话模型委派）' : '（在当前会话直接执行）') : ''}${stage && stage.authorized === false ? ' ⚠ 未授权' : ''}`
    const route = stage && stage.route && !stage.fallback ? `<br/>${stage.route.provider} · ${stage.route.model}` : ''
    lines.push(`  ${node.id}["${label}${markers}${route}"]`)
  }
  for (const node of resolved.nodes ?? []) {
    for (const next of node.next ?? []) {
      lines.push(next.when === null ? `  ${node.id} --> ${next.to}` : `  ${node.id} -- "${next.when}" --> ${next.to}`)
    }
  }
  return lines.join('\n')
}

/**
 * Turn problems into one-line human sentences (code, level, what to change).
 *
 * @param {Problem[]} problems
 * @returns {string[]}
 */
export function diagnose(problems) {
  return (problems ?? []).map(item => `${item.code} [${item.level}] ${item.message}`)
}

/**
 * One-line summary used by the tool when the flow is not usable.
 *
 * @param {Resolved} resolved
 * @returns {string}
 */
export function summarize(resolved) {
  const errors = (resolved?.problems ?? []).filter(item => item.level === 'error')
  if (!resolved?.ok) {
    return `racing-code: 流程不可用（${errors.length} 个错误）：${errors.map(item => item.code).join(', ') || 'FLOW_NO_ENTRY'}`
  }
  return `racing-code: 流程可用，入口 ${resolved.entry}，${resolved.stages.length} 个阶段、${resolved.joins.length} 个并行赛段、${resolved.loops.length} 条回边`
}

/**
 * Parse a flow document and run every check, in one call. This is the entry point the
 * source layer uses; it never throws.
 *
 * @param {string} text Contents of the project's flow file.
 * @param {{maxStageRepeats?: number, maxLanes?: number, maxReviewRounds?: number,
 *          sessionRoute?: Route|null, allowedModels?: {provider: string, model: string}[]|null}} [opts]
 * @returns {Resolved}
 */
export function resolveFlow(text, opts = {}) {
  const front = parseFrontMatter(text)
  const parsed = parseMermaid(front.body)
  const problems = [...front.problems, ...parsed.problems]

  const version = front.data['racing-code']
  if (version !== undefined && version !== 1) {
    problems.push(problem('FLOW_VERSION_UNSUPPORTED', 'error', `流程格式版本 ${version} 不支持（本插件只认 1）`))
  }

  const laneDir = resolveLaneDir(front.data.laneDir)
  problems.push(...laneDir.problems)

  const guards = {}
  for (const key of Object.keys(DEFAULTS)) {
    const fromFile = front.data[key]
    if (typeof fromFile === 'number' && Number.isFinite(fromFile) && fromFile > 0) guards[key] = Math.floor(fromFile)
    else if (typeof opts[key] === 'number') guards[key] = opts[key]
  }

  const resolved = buildFlow({ nodes: parsed.nodes, edges: parsed.edges, entry: parsed.entry, problems },
    { ...guards, laneDir: laneDir.laneDir })
  const merged = mergeRoutes(resolved.stages, front.data.models ?? {}, opts.sessionRoute ?? null)
  const authorized = checkAuthorized(merged.stages, opts.allowedModels ?? null)
  const reviewer = checkReviewer(merged.stages, resolved.joins.flatMap(join => join.lanes.map(id => ({ id, joinAt: join.at }))))
  const shadowed = checkLabelShadowing(parsed.nodes, merged.stages)
  const { stages } = attachInstructions(merged.stages, front.body)

  const all = [
    ...resolved.problems,
    ...merged.problems,
    ...authorized.problems,
    ...reviewer.problems,
    ...shadowed.problems,
  ]
  return { ...resolved, laneDir: laneDir.laneDir, stages, problems: all, ok: !all.some(item => item.level === 'error') }
}
