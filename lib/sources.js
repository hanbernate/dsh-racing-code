/**
 * Source layer: read a project's flow file, decide whether the plugin is enabled for
 * that project, and watch the file for changes.
 *
 * This module owns every filesystem interaction of the plugin. It never throws: a
 * missing file is a normal outcome ("not enabled"), and a broken file is reported as
 * `invalid` so the caller can inject one diagnostic line instead of a flow.
 *
 * @module dsh-racing-code/sources
 */

import { isAbsolute, join } from 'node:path'
import { parseYamlSubset, resolveFlow } from './flow.js'
import { checkBootstrapTarget } from './bootstrap.js'

/**
 * @typedef {object} Problem
 * @property {string} code
 * @property {'info'|'warn'|'error'} level
 * @property {string} message
 * @property {number} [line]
 * @property {string} [node]
 */

/**
 * @typedef {object} FlowSource
 * @property {'disabled'|'missing'|'unreadable'|'invalid'|'ok'} status
 * @property {boolean} enabled True only for `ok`; every other status injects nothing
 *   (or, for `invalid`/`unreadable`, a single diagnostic line).
 * @property {string} file Absolute path that was inspected.
 * @property {unknown} [target] Filesystem target, when it could be resolved (watch it with
 *   {@link watchFlow}).
 * @property {string} [text] Raw file contents, when they were read.
 * @property {object} [resolved] `resolveFlow` result, when text was read.
 * @property {Problem[]} problems `FLOW_FILE_*` diagnostics plus everything `resolveFlow` reported.
 */

/** Every status {@link loadFlow} can return. */
export const STATUSES = ['disabled', 'missing', 'unreadable', 'invalid', 'ok']

const DEFAULT_FLOW_PATH = 'docs/racing-code.md'
const NOT_FOUND = new Set(['FS_NOT_FOUND', 'ENOENT'])

function problem(code, level, message) {
  return { code, level, message }
}

function detail(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/**
 * Absolute path of the project's flow file. `projectFlowPath` may be relative to the
 * session cwd (the normal case) or absolute (an escape hatch for tests and odd layouts).
 *
 * @param {string} cwd Session working directory (the project root).
 * @param {string} projectFlowPath Configured path, e.g. `docs/racing-code.md`.
 * @returns {string}
 */
export function flowFilePath(cwd, projectFlowPath) {
  const configured = String(projectFlowPath ?? '').trim() || DEFAULT_FLOW_PATH
  if (isAbsolute(configured)) return configured
  const root = String(cwd ?? '').trim()
  return root ? join(root, configured) : configured
}

function missing(file) {
  return problem('FLOW_FILE_MISSING', 'info',
    `本项目没有 ${file}：racing-code 未启用（要启用就创建它，并在里面画一张 mermaid 流程图）`)
}

function unreadable(file, error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '读取失败'
  return problem('FLOW_FILE_UNREADABLE', 'error', `读不到 ${file}（${code}）：${detail(error)}`)
}

/**
 * Read the flow file without interpreting it.
 *
 * Statuses: `ok` (text read), `missing` (no such file — the normal "not enabled" path),
 * `unreadable` (exists but cannot be read as UTF-8 text). Never throws.
 *
 * @param {{resolve(path: string): Promise<unknown>, readText(target: unknown): Promise<string>}} fs
 *   Filesystem service (`ctx.fs`); only these two methods are used.
 * @param {string} cwd
 * @param {string} projectFlowPath
 * @returns {Promise<{status: 'missing'|'unreadable'|'ok', file: string, target?: unknown,
 *   text?: string, problems: Problem[]}>}
 */
export async function readProjectFlow(fs, cwd, projectFlowPath) {
  const file = flowFilePath(cwd, projectFlowPath)
  let target
  try {
    target = await fs.resolve(file)
  } catch (error) {
    if (error && typeof error === 'object' && NOT_FOUND.has(String(error.code))) {
      return { status: 'missing', file, problems: [missing(file)] }
    }
    return { status: 'unreadable', file, problems: [unreadable(file, error)] }
  }
  try {
    const text = await fs.readText(target)
    return { status: 'ok', file, target, text, problems: [] }
  } catch (error) {
    if (error && typeof error === 'object' && NOT_FOUND.has(String(error.code))) {
      return { status: 'missing', file, problems: [missing(file)] }
    }
    return { status: 'unreadable', file, problems: [unreadable(file, error)] }
  }
}

// ─────────────────────────────── per-project config ───────────────────────────────

/** The project config file, relative to the session cwd (the project root). */
const PROJECT_CONFIG_PATH = '.dsh/racing-code.yml'
/** The three guards a project config may set, same keys as the global Config. */
const PROJECT_GUARD_KEYS = ['maxStageRepeats', 'maxLanes', 'maxReviewRounds']

/**
 * Read a project's own `<cwd>/.dsh/racing-code.yml`. Missing file → an empty config and
 * no problems (per-project configuration is optional). Unknown keys are ignored; a value of
 * the wrong type is reported as `FLOW_PROJECT_CONFIG_INVALID` (warn) and dropped, so every
 * problem degrades to the global Config instead of failing the load. Never throws.
 *
 * Known keys: `flowPath` (non-empty path), `workBranch` (branch name; `""` explicitly disables
 * the lane-name prefix), `enabled` / `bootstrapEnabled` (booleans) and the three guards
 * (positive integers).
 *
 * @param {object} fs Filesystem service, as in {@link readProjectFlow}.
 * @param {string} cwd Session working directory (the project root).
 * @returns {Promise<{config: Record<string, unknown>, file: string, problems: Problem[]}>}
 */
export async function loadProjectConfig(fs, cwd) {
  const file = flowFilePath(cwd, PROJECT_CONFIG_PATH)
  const config = {}
  const problems = []
  let text
  try {
    text = await fs.readText(await fs.resolve(file))
  } catch (error) {
    if (error && typeof error === 'object' && NOT_FOUND.has(String(error.code))) {
      return { config, file, problems }
    }
    problems.push(problem('FLOW_PROJECT_CONFIG_INVALID', 'warn',
      `项目配置 ${file} 读不到（${detail(error)}）：已按无项目配置处理`))
    return { config, file, problems }
  }
  const parsed = parseYamlSubset(text)
  for (const item of parsed.problems) {
    problems.push(problem('FLOW_PROJECT_CONFIG_INVALID', 'warn',
      `项目配置 ${file} 第 ${item.line ?? "?"} 行写法不支持：${item.message}；已忽略这一项`))
  }
  const data = parsed.data
  const bad = (key, expectation) => problems.push(
    problem('FLOW_PROJECT_CONFIG_INVALID', 'warn',
      `项目配置 ${file} 里 ${key} 的值不合法（${expectation}）：已忽略这一项`))

  if (data.flowPath !== undefined) {
    if (typeof data.flowPath === 'string' && data.flowPath.trim() !== '') config.flowPath = data.flowPath.trim()
    else bad('flowPath', '要非空的路径字符串，相对项目根')
  }
  if (data.workBranch !== undefined) {
    // `""` is meaningful here: it explicitly disables the lane-name prefix for this project,
    // so it is kept instead of dropped.
    if (typeof data.workBranch === 'string') config.workBranch = data.workBranch.trim()
    else if (typeof data.workBranch === 'number' && Number.isFinite(data.workBranch)) config.workBranch = String(data.workBranch)
    else bad('workBranch', '要分支名字符串；"" 表示显式关闭前缀')
  }
  for (const key of ['enabled', 'bootstrapEnabled']) {
    const value = data[key]
    if (value === undefined) continue
    if (typeof value === 'boolean') config[key] = value
    else bad(key, '要 true / false')
  }
  for (const key of PROJECT_GUARD_KEYS) {
    const value = data[key]
    if (value === undefined) continue
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) config[key] = value
    else bad(key, '要正整数')
  }
  return { config, file, problems }
}

// ─────────────────────────────── work-branch detection ───────────────────────────────

/**
 * The branch name in a `HEAD` text: `ref: refs/heads/<name>` → `<name>`; a detached HEAD or
 * anything unreadable → null (unknown, never a guess).
 */
function branchFromHead(head) {
  const line = String(head ?? '').split('\n').map(item => item.trim()).find(item => item.startsWith('ref:'))
  if (!line) return null
  const target = line.slice(4).trim()
  const prefix = 'refs/heads/'
  return target.startsWith(prefix) && target.length > prefix.length ? target.slice(prefix.length) : null
}

/**
 * Read the branch the `.git` at `base` points at: a branch name, null (`.git` is there but no
 * branch could be read — detached, broken pointer), or undefined (no `.git` at this level,
 * keep walking up). `.git` may be a directory (read `<git>/HEAD`) or a `gitdir:` pointer file
 * (the target is resolved against the directory containing `.git`, relative or absolute).
 */
async function headBranchOf(fs, base) {
  try {
    await fs.resolve(`${base}/.git`)
  } catch (error) {
    return undefined
  }
  try {
    const head = await fs.readText(await fs.resolve(`${base}/.git/HEAD`))
    return branchFromHead(head)
  } catch (error) { /* `.git` may be a pointer file, not a directory */ }
  try {
    const pointer = await fs.readText(await fs.resolve(`${base}/.git`))
    const line = String(pointer).split('\n').find(item => item.trim().startsWith('gitdir:'))
    const pointed = line ? line.slice(line.indexOf('gitdir:') + 7).trim() : ''
    if (!pointed) return null
    const gitdir = pointed.startsWith('/') ? pointed : join(base, pointed)
    return branchFromHead(await fs.readText(await fs.resolve(`${gitdir}/HEAD`)))
  } catch (error) {
    return null
  }
}

/**
 * Detect the working branch of the git worktree that holds a flow file, without a subprocess:
 * walk from the file's directory up to (and including) `cwd`, and take the nearest `.git`. A
 * normal repository reads `<git>/HEAD`; a worktree (`gitdir:` pointer) reads the pointed
 * worktree's HEAD. Yields the branch name, or null when there is no git, the HEAD is detached,
 * or nothing could be read — callers then fall back to the unprefixed lane naming.
 *
 * @param {object} fs Filesystem service, as in {@link readProjectFlow} (resolve + readText).
 * @param {string} file Absolute path of the flow file whose worktree is probed.
 * @param {string} cwd Session working directory; the walk stops here (inclusive).
 * @returns {Promise<string|null>}
 */
export async function detectWorkBranch(fs, file, cwd) {
  const segments = String(file ?? '').split('/').filter(Boolean)
  segments.pop()
  const cwdSegments = String(cwd ?? '').split('/').filter(Boolean)
  // Stop at cwd when it holds the file; otherwise walk up to the filesystem root.
  const stop = cwdSegments.length > 0 && cwdSegments.every((segment, index) => segments[index] === segment)
    ? cwdSegments.length : 0
  for (;;) {
    const base = '/' + segments.join('/')
    const found = await headBranchOf(fs, base)
    if (found !== undefined) return found
    if (segments.length <= stop) return null
    segments.pop()
  }
}

// ─────────────────────────────── the load decision ───────────────────────────────

/**
 * Decide whether racing-code is enabled for a project, and resolve the flow when it is.
 *
 * Reads the per-project config first ({@link loadProjectConfig}); the project file overrides
 * the global Config for `flowPath` / `workBranch` / `enabled` / `bootstrapEnabled`, while the
 * guards keep the precedence flow front matter > project config > global Config (the front
 * matter wins inside `resolveFlow`). A global `enabled: false` is the hard master switch:
 * nothing is read at all. A project may opt out with `enabled: false` but can never revive a
 * globally disabled plugin. A project `flowPath` that escapes the project root is refused
 * (`FLOW_PROJECT_CONFIG_INVALID`, warn) and the global/default path is used instead.
 *
 * - global `config.enabled === false` → `disabled` (nothing is read).
 * - file missing → `missing` (`FLOW_FILE_MISSING`, info): the plugin injects nothing at all.
 * - file unreadable → `unreadable` (`FLOW_FILE_UNREADABLE`, error): one diagnostic line.
 * - file parsed but invalid → `invalid`: the flow is **not** enabled, but the diagnostics
 *   travel back so the session can say what to fix.
 * - otherwise → `ok`: `resolved` carries the flow, its lanes, its loops and any warnings.
 *
 * @param {object} fs Filesystem service, as in {@link readProjectFlow}.
 * @param {string} cwd
 * @param {{enabled?: boolean, projectFlowPath?: string, workBranch?: string,
 *          maxStageRepeats?: number, maxLanes?: number, maxReviewRounds?: number}} config Plugin Config.
 * @param {{sessionRoute?: object|null, allowedModels?: object[]|null,
 *          runtimePool?: object[]|null}} [context]
 *   Route of the session that will delegate, the subagent allowlist (null = unavailable),
 *   and the DSH runtime pool (plan §5: llm directory ∩ allowlist, directory order). An
 *   omitted `runtimePool` switches runtime resolution off; null means the directory is
 *   unavailable; an array (possibly empty) means it is available.
 * @returns {Promise<FlowSource>}
 */
export async function loadFlow(fs, cwd, config = {}, context = {}) {
  // The global master switch reads nothing: no project config, no flow file, no git.
  if (config.enabled === false) {
    return { status: 'disabled', enabled: false, file: flowFilePath(cwd, config.projectFlowPath), problems: [] }
  }

  const project = await loadProjectConfig(fs, cwd)

  // flowPath: project config wins over the global Config — unless it escapes the project root.
  let flowPath = project.config.flowPath
  if (flowPath !== undefined && typeof cwd === 'string' && cwd.startsWith('/')) {
    const contained = checkBootstrapTarget({ cwd, projectFlowPath: flowPath })
    if (!contained.ok) {
      project.problems.push(problem('FLOW_PROJECT_CONFIG_INVALID', 'warn',
        `项目配置的 flowPath 归一化后不在项目根内：${contained.message}；已忽略项目配置的 flowPath`))
      flowPath = undefined
    }
  }
  if (flowPath === undefined) flowPath = config.projectFlowPath
  const file = flowFilePath(cwd, flowPath)

  // A project may opt out; reviving a globally disabled plugin is impossible (returned above).
  if (project.config.enabled === false) {
    return { status: 'disabled', enabled: false, file, problems: project.problems }
  }

  // Guards: flow front matter > project config > global Config.
  const guards = {}
  for (const key of PROJECT_GUARD_KEYS) {
    guards[key] = project.config[key] !== undefined ? project.config[key] : config[key]
  }

  const read = await readProjectFlow(fs, cwd, flowPath)
  if (read.status !== 'ok') {
    return { status: read.status, enabled: false, file: read.file, problems: [...project.problems, ...read.problems] }
  }

  // Lane-naming prefix (scheme B): project config > global Config > detect it from the git
  // worktree that holds the flow file. Front matter `workBranch` still wins inside resolveFlow,
  // and `workBranch: ""` there explicitly turns the prefix off.
  let workBranch = project.config.workBranch !== undefined
    ? project.config.workBranch
    : (typeof config.workBranch === 'string' ? config.workBranch : undefined)
  if (workBranch === undefined) workBranch = await detectWorkBranch(fs, file, cwd)

  const resolved = resolveFlow(read.text, {
    ...guards,
    workBranch: workBranch ?? undefined,
    sessionRoute: context.sessionRoute ?? null,
    allowedModels: context.allowedModels ?? null,
    runtimePool: context.runtimePool ?? null,
  })

  return {
    status: resolved.ok ? 'ok' : 'invalid',
    enabled: resolved.ok,
    file: read.file,
    target: read.target,
    text: read.text,
    resolved,
    problems: [...project.problems, ...resolved.problems],
  }
}

/**
 * Watch one flow file. The returned disposer aborts the watch; calling it twice is safe.
 * A failed watch never throws and never blocks enabling: it returns a no-op disposer and
 * reports through `onError` (changes then only take effect in a new session).
 *
 * @param {{watch(target: unknown, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>>}} fs
 * @param {unknown} target Filesystem target from {@link loadFlow}.
 * @param {(error?: Error) => void} onChange Called on every change; the session re-reads the file.
 * @param {(error: unknown) => void} [onError]
 * @returns {() => Promise<void>}
 */
export function watchFlow(fs, target, onChange, onError) {
  const controller = new AbortController()
  let inner
  let disposed = false

  const ready = (async () => {
    try {
      inner = await fs.watch(
        target,
        error => { try { onChange?.(error) } catch { /* a listener must not break the watcher */ } },
        controller.signal,
      )
    } catch (error) {
      inner = undefined
      onError?.(error)
    }
  })()

  return async () => {
    if (disposed) return
    disposed = true
    controller.abort()
    await ready
    if (inner) {
      try {
        await inner()
      } catch (error) {
        onError?.(error)
      }
    }
  }
}
