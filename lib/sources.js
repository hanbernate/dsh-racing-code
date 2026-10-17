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
import { resolveFlow } from './flow.js'

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

const DEFAULT_FLOW_PATH = 'doc/racing-code.md'
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
 * @param {string} projectFlowPath Configured path, e.g. `doc/racing-code.md`.
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

/**
 * Decide whether racing-code is enabled for a project, and resolve the flow when it is.
 *
 * - `config.enabled === false` → `disabled` (nothing is read).
 * - file missing → `missing` (`FLOW_FILE_MISSING`, info): the plugin injects nothing at all.
 * - file unreadable → `unreadable` (`FLOW_FILE_UNREADABLE`, error): one diagnostic line.
 * - file parsed but invalid → `invalid`: the flow is **not** enabled, but the diagnostics
 *   travel back so the session can say what to fix.
 * - otherwise → `ok`: `resolved` carries the flow, its lanes, its loops and any warnings.
 *
 * @param {object} fs Filesystem service, as in {@link readProjectFlow}.
 * @param {string} cwd
 * @param {{enabled?: boolean, projectFlowPath?: string, maxStageRepeats?: number,
 *          maxLanes?: number, maxReviewRounds?: number}} config Plugin Config.
 * @param {{sessionRoute?: object|null, allowedModels?: object[]|null}} [context]
 *   Route of the session that will delegate, and the subagent allowlist (null = unavailable).
 * @returns {Promise<FlowSource>}
 */
export async function loadFlow(fs, cwd, config = {}, context = {}) {
  const file = flowFilePath(cwd, config.projectFlowPath)
  if (config.enabled === false) return { status: 'disabled', enabled: false, file, problems: [] }

  const read = await readProjectFlow(fs, cwd, config.projectFlowPath)
  if (read.status !== 'ok') {
    return { status: read.status, enabled: false, file: read.file, problems: read.problems }
  }

  const resolved = resolveFlow(read.text, {
    maxStageRepeats: config.maxStageRepeats,
    maxLanes: config.maxLanes,
    maxReviewRounds: config.maxReviewRounds,
    sessionRoute: context.sessionRoute ?? null,
    allowedModels: context.allowedModels ?? null,
  })

  return {
    status: resolved.ok ? 'ok' : 'invalid',
    enabled: resolved.ok,
    file: read.file,
    target: read.target,
    text: read.text,
    resolved,
    problems: resolved.problems,
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
