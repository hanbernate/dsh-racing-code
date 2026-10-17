/**
 * Host half of dsh-racing-code.
 *
 * One per-project decision drives everything: read `<session cwd>/doc/racing-code.md`
 * (Config.projectFlowPath) and, **only when that file declares a parseable flow**,
 * register two things on that agent's scope:
 *
 *   1. a system-prompt section (order 700) with the diagram, the routes and the rules;
 *   2. the read-only `flow_stages` tool for exact ids, worktrees, round limits and briefs.
 *
 * A project without the file gets nothing — no section, no tool, no diagnostics. A file
 * that exists but does not parse injects one diagnostic line instead of a flow, so a
 * broken flow is never silent. There is no global flow and no built-in fallback.
 *
 * @module dsh-racing-code
 */

import { diagnose, renderMermaid, renderPolicySection } from './flow.js'
import { loadFlow, watchFlow } from './sources.js'

/** Tool the orchestrator calls for exact routes, lanes, round limits and stage briefs. */
export const TOOL_NAME = 'flow_stages'

/**
 * Tool the orchestrator calls when the user explicitly asks to bootstrap this project.
 * It previews a flow file by default and writes only after both gates of the bootstrap
 * protocol have passed. It is registered for `missing`/`invalid` projects only (an `ok`
 * project keeps the read-only surface, so a good file can never be overwritten by
 * accident), and only while `Config.bootstrapEnabled` is true.
 */
export const BOOTSTRAP_TOOL_NAME = 'racing_code_init'

/** Services the plugin cannot run without (everything else is read lazily and guarded). */
export const inject = ['agents', 'fs']

const SECTION_NAME = 'racing-code:flow'
const SECTION_ORDER = 700
const DEFAULTS = Object.freeze({
  enabled: true,
  bootstrapEnabled: true,
  projectFlowPath: 'doc/racing-code.md',
  maxStageRepeats: 3,
  maxLanes: 4,
  maxReviewRounds: 2,
})

/** Positive integers only; anything else is a Config issue. */
const POSITIVE_INTEGERS = ['maxStageRepeats', 'maxLanes', 'maxReviewRounds']

/**
 * Config, declared as a Standard Schema so the row's values are validated and defaults
 * filled before {@link apply} runs. No volatile fields: this plugin ships no settings page,
 * so the values live in `cordis.patch.yml`.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-racing-code',
    /**
     * @param {unknown} value Raw row config.
     * @returns {{value: object} | {issues: {message: string, path?: string[]}[]}}
     */
    validate(value) {
      const input = value && typeof value === 'object' ? value : {}
      const issues = []
      const reject = (key, message) => issues.push({ message, path: [key] })
      const config = {
        enabled: input.enabled === undefined ? DEFAULTS.enabled : input.enabled,
        bootstrapEnabled: input.bootstrapEnabled === undefined ? DEFAULTS.bootstrapEnabled : input.bootstrapEnabled,
        projectFlowPath: input.projectFlowPath === undefined ? DEFAULTS.projectFlowPath : input.projectFlowPath,
      }
      for (const key of POSITIVE_INTEGERS) config[key] = input[key] === undefined ? DEFAULTS[key] : input[key]

      if (typeof config.enabled !== 'boolean') reject('enabled', 'enabled must be a boolean')
      if (typeof config.bootstrapEnabled !== 'boolean') reject('bootstrapEnabled', 'bootstrapEnabled must be a boolean')
      if (typeof config.projectFlowPath !== 'string' || config.projectFlowPath.trim() === '')
        reject('projectFlowPath', 'projectFlowPath must be a non-empty path relative to the project root')
      for (const key of POSITIVE_INTEGERS) {
        if (!Number.isInteger(config[key]) || config[key] <= 0) reject(key, `${key} must be a positive integer`)
      }
      return issues.length > 0 ? { issues } : { value: config }
    },
  },
}

/**
 * Normalize a raw row config (used by {@link apply} and by tests that bypass the Loader).
 * @param {unknown} raw
 * @returns {{enabled: boolean, bootstrapEnabled: boolean, projectFlowPath: string, maxStageRepeats: number, maxLanes: number, maxReviewRounds: number}}
 */
export function resolveConfig(raw) {
  const parsed = Config['~standard'].validate(raw)
  if (parsed.value) return parsed.value
  const fallback = { ...DEFAULTS }
  const input = raw && typeof raw === 'object' ? { ...raw } : {}
  for (const key of POSITIVE_INTEGERS) {
    if (!Number.isInteger(input[key]) || input[key] <= 0) input[key] = fallback[key]
  }
  if (typeof input.projectFlowPath !== 'string' || input.projectFlowPath.trim() === '') input.projectFlowPath = fallback.projectFlowPath
  if (typeof input.enabled !== 'boolean') input.enabled = fallback.enabled
  if (typeof input.bootstrapEnabled !== 'boolean') input.bootstrapEnabled = fallback.bootstrapEnabled
  return {
    enabled: input.enabled,
    bootstrapEnabled: input.bootstrapEnabled,
    projectFlowPath: input.projectFlowPath,
    maxStageRepeats: input.maxStageRepeats,
    maxLanes: input.maxLanes,
    maxReviewRounds: input.maxReviewRounds,
  }
}

// ─────────────────────────────── rendering helpers ───────────────────────────────

function policyText(source) {
  return renderPolicySection({ ...(source.resolved ?? {}), file: source.file, problems: source.problems ?? [] })
}

function afterDelete(file) {
  return `racing-code: FLOW_FILE_MISSING_AFTER_ENABLE 本项目的流程文件 ${file} 已被删除或改名：`
    + 'racing-code 在本会话不再生效（新会话将完全不启用）。'
}

function summaryOf(source) {
  if (source.status === 'ok') {
    const resolved = source.resolved
    return `流程可用（入口 ${resolved.entry}）：${resolved.stages.length} 个阶段、`
      + `${resolved.joins.length} 个并行赛段、${resolved.loops.length} 条回边；文件 ${source.file}`
  }
  if (source.status === 'missing') return `本项目未启用 racing-code：没有 ${source.file}`
  if (source.status === 'disabled') return 'racing-code 已被配置关闭（enabled: false）'
  if (source.status === 'unreadable') return `流程文件读不出来：${source.file}`
  return `流程文件不可用（解析失败）：${source.file}`
}

function loopText(loop) {
  return loop.kind === 'review'
    ? `评审轮 ${loop.via}→${loop.backTo}（最多 ${loop.maxRounds} 轮）`
    : `重跑 ${loop.via}→${loop.backTo}（最多 ${loop.maxRepeats} 次）`
}

function detailsOf(source, stage) {
  if (source.status !== 'ok') return diagnose(source.problems).join('\n')
  const resolved = source.resolved
  const blocks = [renderPolicySection({ ...resolved, file: source.file })]
  if (resolved.joins.length > 0) {
    blocks.push(`赛道：${resolved.joins
      .map(join => `${join.lanes.join(' ∥ ')}（汇合于 ${join.at}）`)
      .join('；')}`)
    blocks.push(`worktree：${resolved.stages
      .filter(item => item.lane)
      .map(item => `${item.id}=${item.lane.worktree}（${item.lane.branch}）`)
      .join('  ')}`)
  }
  if (resolved.loops.length > 0) blocks.push(`回边与上限：${resolved.loops.map(loopText).join('；')}`)
  const wanted = stage === undefined ? resolved.stages : resolved.stages.filter(item => item.id === stage)
  for (const item of wanted) {
    if (item.instruction) blocks.push(`### ${item.id}\n${item.instruction}`)
  }
  blocks.push(`\`\`\`mermaid\n${renderMermaid(resolved)}\n\`\`\``)
  return blocks.join('\n\n')
}

/** The read-only tool definition. JSON Schema is written by hand: the package has no dependencies. */
function flowStagesTool(readSource) {
  return {
    name: TOOL_NAME,
    description: 'Read this project\'s development flow: the stage order, the parallel lanes with their '
      + 'git worktree and branch, each stage\'s model route, back edges with their round limits, and the '
      + 'stage briefs. Read-only, and always re-read from disk, so it is the authority on what is in force '
      + 'right now. Call it instead of recalling ids or model names; if the project declares no flow, it '
      + 'says so and nothing else applies.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stage: {
          type: 'string',
          description: 'Optional stage id to narrow the answer to (its route, lane, next steps and brief). Omit for the whole flow.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', description: 'One line: which flow is in force, or why it is not.' },
          details: { type: 'string', description: 'The full picture: compact diagram, routes, lanes, round limits, stage briefs, rendered mermaid.' },
          problems: { type: 'array', items: { type: 'string' }, description: 'Warnings and errors, one per line (FLOW_* codes).' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [value.summary, value.details, ...(value.problems ?? [])].filter(Boolean).join('\n\n'),
      }],
    },
    async execute(args) {
      const raw = args && typeof args === 'object' ? args.stage : undefined
      if (raw !== undefined && typeof raw !== 'string') {
        throw new Error(`${TOOL_NAME}: "stage" must be a string when supplied`)
      }
      const stage = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
      const source = await readSource()
      const problems = diagnose(source.problems)
      if (source.status === 'ok' && stage !== undefined) {
        const known = source.resolved.stages.map(item => item.id)
        if (!known.includes(stage)) {
          return {
            summary: `没有阶段 ${stage}`,
            details: `已知阶段：${known.join(', ')}`,
            problems: [`没有阶段 ${stage}；已知阶段：${known.join(', ')}`],
          }
        }
      }
      return { summary: summaryOf(source), details: detailsOf(source, stage), problems }
    },
  }
}

// ─────────────────────────────── plugin ───────────────────────────────

/**
 * Enable the plugin: one section and one tool per root agent whose project declares a flow.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context.
 * @param {object} [rawConfig] The row's config (validated by {@link Config}).
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const logger = ctx.logger ?? {}
  const warn = message => { try { logger.warn?.(message) } catch { /* logging must never break the plugin */ } }

  /** @type {Map<object, {source: object, lastGood: object|null, text: string, fiber: object|null, watch: Function|null, refreshing: boolean, again: boolean}>} */
  const states = new Map()
  let allowlistWarned = false

  /** The subagent allowlist, or null when the setting is unavailable (then the check is skipped). */
  const allowedModels = () => {
    const service = typeof ctx.get === 'function' ? ctx.get('subagentModelSelection') : undefined
    if (service === undefined) return null
    try {
      const current = service.current?.()
      if (current?.enabled === false) {
        if (!allowlistWarned) {
          allowlistWarned = true
          warn('racing-code: subagent model selection is disabled, so configured stage routes cannot be delegated on')
        }
        return null
      }
      return Array.isArray(current?.allowedModels) ? current.allowedModels : null
    } catch (error) {
      warn(`racing-code: could not read the subagent allowlist: ${describe(error)}`)
      return null
    }
  }

  const readSource = (cwd) => loadFlow(ctx.fs, cwd, config, { allowedModels: allowedModels() })

  const refresh = async (state, cwd) => {
    if (state.refreshing) { state.again = true; return }
    state.refreshing = true
    try {
      const next = await readSource(cwd)
      state.source = next
      if (next.status === 'ok') {
        state.lastGood = next
        state.text = policyText(next)
      } else if (next.status === 'missing') {
        state.text = afterDelete(next.file)
      } else if (state.lastGood) {
        state.text = [
          policyText(state.lastGood),
          '注意：流程文件当前无法解析，以上是上一版可用流程。',
          ...diagnose(next.problems),
        ].join('\n')
      } else {
        state.text = policyText(next)
      }
    } catch (error) {
      warn(`racing-code: refreshing ${state.source?.file ?? 'the flow'} failed: ${describe(error)}`)
    } finally {
      state.refreshing = false
      if (state.again) { state.again = false; void refresh(state, cwd) }
    }
  }

  const teardown = async (agent) => {
    const state = states.get(agent)
    if (state === undefined) return
    states.delete(agent)
    // Release the registrations first (their disposer is invoked synchronously), then let
    // the watcher settle: a session that goes away must stop contributing a prompt at once.
    let fiberDone
    try {
      fiberDone = state.fiber?.dispose?.()
    } catch (error) {
      warn(`racing-code: releasing the flow section failed: ${describe(error)}`)
    }
    try {
      await state.watch?.()
    } catch (error) {
      warn(`racing-code: stopping the flow watcher failed: ${describe(error)}`)
    }
    try {
      await fiberDone
    } catch (error) {
      warn(`racing-code: releasing the flow section failed: ${describe(error)}`)
    }
  }

  const install = async (agent) => {
    if (states.has(agent)) return
    if (agent.parentAgent !== undefined) return // only the orchestrator runs the flow
    const cwd = agent.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return

    const source = await readSource(cwd)
    if (source.status === 'missing' || source.status === 'disabled') return

    const state = { source, lastGood: source.status === 'ok' ? source : null, text: policyText(source), fiber: null, watch: null, refreshing: false, again: false }
    states.set(agent, state)

    state.fiber = agent.ctx.inject(['systemPrompt', 'tools'], scope => {
      scope.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: () => state.text,
      })
      scope.tools.register(flowStagesTool(() => readSource(cwd)))
    })

    if (source.target !== undefined) {
      state.watch = watchFlow(
        ctx.fs,
        source.target,
        () => { void refresh(state, cwd) },
        error => warn(`racing-code: watching ${source.file} failed (changes will need a new session): ${describe(error)}`),
      )
    }
  }

  ctx.on('agent/created', async ({ agent }) => {
    try {
      await install(agent)
    } catch (error) {
      warn(`racing-code: enabling ${agent?.sessionId ?? 'the session'} failed: ${describe(error)}`)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => { void teardown(agent) })

  for (const agent of ctx.agents.list()) void install(agent)

  ctx.effect(() => async () => {
    for (const agent of [...states.keys()]) await teardown(agent)
  }, 'racing-code: per-agent flow state')
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
