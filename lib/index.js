/**
 * Host half of dsh-racing-code.
 *
 * One per-project decision drives everything: read `<session cwd>/docs/racing-code.md`
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

import { diagnose, laneAgentNameLine, renderMermaid, renderPolicySection, resolveFlow } from './flow.js'
import {
  bootstrapProtocol, buildPlan, buildRouteChoices, checkBootstrapTarget, renderBootstrapTemplate,
} from './bootstrap.js'
import { flowFilePath, loadFlow, watchFlow } from './sources.js'

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
  projectFlowPath: 'docs/racing-code.md',
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
  const agentNames = laneAgentNameLine(resolved.stages)
  if (agentNames) blocks.push(agentNames)
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

// ─────────────────────────────── bootstrap tool ───────────────────────────────

/**
 * The facts buildPlan needs, from ctx.fs only — never a subprocess (docs/bootstrap.md §3.2):
 * stat/readText on <cwd>/.git, <cwd>/.bare, the target file and its parent, plus the raw
 * .gitignore contents.
 */
async function collectBootstrapFacts(fs, cwd, file) {
  const statOf = async path => {
    try { return await fs.stat(await fs.resolve(path)) } catch { return undefined }
  }
  const gitLayout = await (async () => {
    const info = await statOf(`${cwd}/.git`)
    if (!info || info.type === undefined) return 'none'
    if (info.type === 'directory') return 'git-repo'
    let text = null
    try { text = await fs.readText(await fs.resolve(`${cwd}/.git`)) } catch { return 'unknown' }
    if (typeof text !== 'string') return 'unknown'
    // A .git pointer file is `gitdir: <path>`; the path may contain spaces, so take the
    // rest of the line instead of a token, and resolve a relative path against the
    // directory that contains .git (= cwd).
    const line = text.split('\n').find(candidate => candidate.trim().startsWith('gitdir:'))
    const pointed = line ? line.slice(line.indexOf('gitdir:') + 7).trim() : ''
    if (!pointed) return 'unknown'
    const places = pointed.startsWith('/') ? [pointed] : [`${cwd}/${pointed}`, pointed]
    let exists = false
    for (const place of places) {
      const found = await statOf(place)
      if (found && found.type !== undefined) { exists = true; break }
    }
    if (!exists) return 'unknown'
    const bare = await statOf(`${cwd}/.bare`)
    return (bare?.type === 'directory' || pointed.includes('.bare/')) ? 'worktree-container' : 'git-repo'
  })()
  let gitignore
  try { gitignore = await fs.readText(await fs.resolve(`${cwd}/.gitignore`)) } catch { gitignore = null }
  const fileInfo = await statOf(file)
  const parent = file.slice(0, Math.max(file.lastIndexOf('/'), 0))
  const parentInfo = parent ? await statOf(parent) : undefined
  return {
    file,
    fileExists: fileInfo !== undefined && fileInfo.type !== undefined,
    fileVersion: fileInfo?.version,
    parentExists: parentInfo?.type === 'directory',
    gitLayout,
    gitignore: typeof gitignore === 'string' ? gitignore : null,
  }
}

/**
 * The bootstrap entry (docs/bootstrap.md §3.1): registered for missing/invalid projects
 * only, and only while Config.bootstrapEnabled is true. Preview by default; write:true
 * lands the file only after both user gates passed — every parallel lane must have a
 * user-picked model (BOOTSTRAP_CHOICE_REQUIRED otherwise), an existing file needs force
 * (BOOTSTRAP_FILE_EXISTS), and a success reports BOOTSTRAP_RESTART_REQUIRED. It never
 * throws: every failure comes back as wrote:false plus diagnostics.
 */
/** The gate-2 tabs as compact lines: id, label, default, candidates — no JSON dump. */
function choiceLines(nodes) {
  const lines = (nodes ?? []).map(node => {
    const flag = node.required ? '*' : ' '
    const candidates = (node.candidates ?? []).map(entry => `${entry.provider}/${entry.model}`).join('、') || '（无候选）'
    return `  -${flag} ${node.id}（${node.label}${node.brief ? `｜${node.brief}` : ''}）默认 session；候选：${candidates}`
  })
  return lines.length > 0 ? ['节点选项卡（* 为必选赛道；默认都是当前会话模型）：', ...lines].join('\n') : ''
}

/** The pre-flight plan as compact lines: status, what was found, and how to fix it. */
function planLines(plan) {
  const lines = (plan ?? []).map(item => `  - [${item.status}] ${item.item}：${item.detail}${item.fix ? `（fix：${item.fix}）` : ''}`)
  return lines.length > 0 ? ['前置检查：', ...lines].join('\n') : ''
}

/**
 * Contract for the bootstrap write (docs/development.md R11): the caller passes
 * `sandboxPolicy`, a zero-argument resolver that returns the calling Session's policy
 * (`ctx.sandboxPolicy.resolve({ session })`) or `undefined` when no policy service is
 * mounted. On `write:true` the body MUST call it and pass the result as the 5th
 * argument (`sandboxPolicy`) to `fs.writeText`, so a sandboxing backend fences the write
 * by the session mode and workspace root instead of its deployment default. A resolver
 * that throws MUST NOT block the write: warn and stamp `undefined`.
 * @param {object} options
 * @param {() => (object | undefined)} options.sandboxPolicy
 */
function racingCodeInitTool({ fs, config, cwd, readSource, allowedModels, loadCatalog, sandboxPolicy }) {
  return {
    name: BOOTSTRAP_TOOL_NAME,
    description: '仅当用户明确要求为本项目建立流程时调用；默认只预览、不写盘。'
      + ' Creates this project\'s flow file (docs/racing-code.md by default) through the two-gate'
      + ' bootstrap protocol: preview the structure first (every stage rendered as session),'
      + ' then ask the user for a model per stage, then write:true lands the file. Parallel'
      + ' lanes must all be chosen before anything lands; force only overwrites a broken file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        template: {
          type: 'string', enum: ['full', 'minimal'],
          description: 'Preset graph: full (default) is this repository\'s own graph; minimal drops the plan/final prologue.',
        },
        lanes: {
          type: 'integer', enum: [2, 3, 4],
          description: 'How many stages the race group fans out to. Default 2.',
        },
        models: {
          type: 'object', additionalProperties: { type: 'string' },
          description: 'Stage id → provider/model or session. Only the given keys override; every parallel lane must be chosen before write.',
        },
        write: {
          type: 'boolean',
          description: 'Default false: preview only (no filesystem write). true lands the file after both user gates passed.',
        },
        force: {
          type: 'boolean',
          description: 'Only with write:true: replace an existing (broken) file via replaceIfVersion instead of refusing.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', description: 'One line: what happened (previewed / written / refused, and why).' },
          wrote: { type: 'boolean', description: 'True only when the file actually landed.' },
          file: { type: 'string', description: 'Absolute target path (= projectFlowPath inside cwd).' },
          template: { type: 'string', description: 'The full file text — the same text the preview showed and the write lands.' },
          nodes: { type: 'array', items: { type: 'object' }, description: 'Gate 2 tabs: one per stage, in flow order.' },
          plan: { type: 'array', items: { type: 'object' }, description: 'Pre-flight checks (item, status, detail, fix?).' },
          protocol: { type: 'array', items: { type: 'string' }, description: 'The nine steps of the two-gate protocol.' },
          diagnostics: { type: 'array', items: { type: 'string' }, description: 'BOOTSTRAP_* / FLOW_* lines for the orchestrator.' },
          nextStep: { type: 'string', description: 'What to do next; always mentions that a new session is required.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.summary,
          value.template ? ['模板全文（write:true 落盘的就是这一份）：', '```markdown', value.template, '```'].join('\n') : '',
          choiceLines(value.nodes),
          planLines(value.plan),
          ['协议：', ...(value.protocol ?? [])].join('\n'),
          ...(value.diagnostics ?? []),
          value.nextStep,
        ].filter(Boolean).join('\n\n'),
      }],
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const diagnostics = []
      const wanted = {
        template: args.template,
        lanes: args.lanes,
        models: args.models && typeof args.models === 'object' && !Array.isArray(args.models) ? args.models : undefined,
        write: args.write === true,
        force: args.force === true,
      }
      const lanes = Number.isInteger(wanted.lanes) ? wanted.lanes : 2
      const nextStep = '两次介入完成后 write:true 落盘；写入成功后要新开会话才生效。'

      const target = checkBootstrapTarget({ cwd, projectFlowPath: config.projectFlowPath })
      const file = target.ok ? target.file : flowFilePath(cwd, config.projectFlowPath)
      // The protocol travels with every answer, previews and early refusals included:
      // this text is the only place the two-gate contract lives.
      const protocol = bootstrapProtocol({ file, lanes })
      const result = patch => ({
        summary: '', wrote: false, file: '', template: '', nodes: [], plan: [], protocol, diagnostics, nextStep,
        ...(patch && typeof patch === 'object' ? patch : {}),
      })

      if (!target.ok) {
        diagnostics.push(`${target.code} ${target.message}（目标必须留在项目根内；要换位置改 Config.projectFlowPath）`)
        return result({ file, summary: `未生成：${target.code}` })
      }

      const facts = await collectBootstrapFacts(fs, cwd, file)
      const specLaneDir = facts.gitLayout === 'worktree-container' ? 'branch' : undefined

      let template
      try {
        template = renderBootstrapTemplate({
          template: wanted.template ?? 'full',
          lanes: wanted.lanes ?? 2,
          models: wanted.models,
          laneDir: specLaneDir,
          generatedOn: new Date().toISOString().slice(0, 10),
        })
      } catch (error) {
        diagnostics.push(describe(error))
        return result({ file, summary: `未生成：${String(describe(error)).split(' ')[0]}` })
      }

      // The generator's red line, re-checked here: a half-valid file is never shown or written.
      const resolved = resolveFlow(template, {})
      if (!resolved.ok) {
        diagnostics.push('BOOTSTRAP_TEMPLATE_INVALID 生成文本自校验未通过，拒绝继续：', ...diagnose(resolved.problems))
        return result({ file, template, summary: '未生成：自校验失败（BOOTSTRAP_TEMPLATE_INVALID）' })
      }

      const allow = allowedModels()
      const catalog = await loadCatalog()
      const choices = buildRouteChoices({
        allowedModels: allow,
        catalog,
        stages: resolved.stages.map(stage => ({ id: stage.id, label: stage.label, instruction: stage.instruction })),
        lanes: resolved.stages.filter(stage => stage.lane).map(stage => ({ id: stage.id, joinAt: stage.lane.joinAt })),
      })
      diagnostics.push(...choices.notes)

      const plan = buildPlan({
        file, fileExists: facts.fileExists, parentExists: facts.parentExists,
        gitLayout: facts.gitLayout, laneDir: specLaneDir, gitignore: facts.gitignore,
        nodes: choices.nodes, candidates: catalog ?? [],
      })
      const preview = (summary, extra = []) => result({
        summary, wrote: false, file, template,
        nodes: choices.nodes, plan, protocol, diagnostics: [...diagnostics, ...extra], nextStep,
      })

      if (!wanted.write) {
        return preview(`racing_code_init 预览：目标 ${file}，未写盘（write 默认 false）；介入 1 先确认结构。`)
      }

      // Pre-flight: anything the plan marks blocked (missing parent dir, no git, …) keeps
      // the file from landing — the fix travels with the plan.
      const blocked = plan.filter(item => item.status === 'blocked')
      if (blocked.length > 0) {
        return preview('未写入：前置检查有 blocked 项（BOOTSTRAP_PLAN_BLOCKED）', [
          `BOOTSTRAP_PLAN_BLOCKED 先把 plan 里的 blocked 项清掉再写盘：${blocked.map(item => item.item).join('、')}。`,
          ...blocked.map(item => `${item.detail}${item.fix ? ` fix：${item.fix}` : ''}`),
        ])
      }

      // Gate 2 completeness: every parallel lane needs a user-picked model.
      const missingChoices = choices.nodes.filter(node => node.required && wanted.models?.[node.id] === undefined)
      if (missingChoices.length > 0) {
        return preview('未写入：赛道模型未选齐（BOOTSTRAP_CHOICE_REQUIRED）', [
          `BOOTSTRAP_CHOICE_REQUIRED 介入 2 未完成：并行赛道必须由用户逐条选定模型，还差 ${missingChoices.map(node => node.id).join('、')}（拒写）。`,
        ])
      }

      // Never clobber a flow that already works; an existing file is only replaced on explicit force.
      const fresh = await readSource(cwd)
      if (fresh.status === 'ok') {
        return preview('未写入：流程文件已可用（不覆盖好文件）', [
          `BOOTSTRAP_FILE_EXISTS ${file} 现在已是一份可用流程：bootstrap 不覆盖好文件（要改就直接编辑该文件）。`,
        ])
      }
      if (facts.fileExists && !wanted.force) {
        return preview('未写入：目标已存在（BOOTSTRAP_FILE_EXISTS，需要 force）', [
          `BOOTSTRAP_FILE_EXISTS ${file} 已存在：默认不覆盖（只新建；解析失败的坏文件才用 force）。要覆盖请带 force:true 重新执行。`,
        ])
      }

      const writeTarget = await fs.resolve(file)
      const expected = facts.fileExists
        ? { kind: 'replaceIfVersion', version: facts.fileVersion }
        : { kind: 'createIfAbsent' }
      // Stamp the calling Session's sandbox policy onto the write (contract above), so a
      // confining backend fences it by the session mode and not by its deployment default.
      const policy = sandboxPolicy?.()
      try {
        await fs.writeText(writeTarget, template, expected, undefined, policy)
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
        if (code === 'FS_STALE_VERSION') {
          return preview(`未写入：${code || '写入失败'}`, [
            `BOOTSTRAP_WRITE_CONFLICT ${file} 在预览之后又被改动（版本不匹配）：重新预览后再试。`,
          ])
        }
        if (code === 'FS_NOT_OBSERVED') {
          return preview(`未写入：${code || '写入失败'}`, [
            `BOOTSTRAP_FILE_EXISTS ${file} 在预览之后出现了：重新预览；要覆盖坏文件带 force:true。`,
          ])
        }
        return preview(`未写入：${code || '写入失败'}`, [
          `BOOTSTRAP_WRITE_FAILED 写入 ${file} 被拒绝${code ? `（${code}）` : ''}：${describe(error)}。两级降级：申请提权后重试，或按下面全文手动创建。`,
        ])
      }

      diagnostics.push('BOOTSTRAP_RESTART_REQUIRED 流程文件已写入：本会话不切换流程，新开会话后才生效。')
      for (const line of diagnose(resolved.problems)) diagnostics.push(line)
      return result({
        summary: `已写入 ${file}（${expected.kind}）：流程入口 ${resolved.entry}、${resolved.stages.length} 个阶段。`,
        wrote: true,
        file, template,
        nodes: choices.nodes, plan, protocol, diagnostics,
        nextStep: '流程文件已写入；新开会话后生效。git / worktree / .gitignore 的命令由你征得用户同意后执行（插件不跑子进程）。',
      })
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

  /**
   * The calling Session's sandbox policy resolver, closed over one agent: zero-argument,
   * looked up lazily on every call. undefined when no policy service is mounted; a resolver
   * that throws only warns and degrades to undefined (the backend default), so it can never
   * block the bootstrap write.
   */
  const sessionSandboxPolicy = agent => () => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined
      if (service === undefined || service === null) return undefined
      return service.resolve({ session: agent.session })
    } catch (error) {
      warn('racing-code: could not resolve the session sandbox policy for the bootstrap write '
        + `(falling back to the backend default): ${describe(error)}`)
      return undefined
    }
  }

  const readSource = (cwd) => loadFlow(ctx.fs, cwd, config, { allowedModels: allowedModels() })

  /** The local llm directory (every provider × its advertised models), or null when the
   * service is unavailable — the candidate pool then stays empty and says why. */
  const loadCatalog = async () => {
    const service = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (service === undefined || service === null) return null
    try {
      const providers = typeof service.listProviders === 'function' ? service.listProviders() : []
      const entries = []
      for (const provider of providers ?? []) {
        const models = typeof service.listModels === 'function' ? await service.listModels(provider?.id) : []
        for (const model of models ?? []) {
          if (!model?.id) continue
          entries.push({ provider: provider?.id, model: model.id, ...(model.description ? { note: model.description } : {}) })
        }
      }
      return entries
    } catch (error) {
      warn(`racing-code: could not read the local llm directory: ${describe(error)}`)
      return null
    }
  }

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
    if (source.status === 'missing' || source.status === 'disabled') {
      // Decision 1 (docs/bootstrap.md §0): a project without a flow file stays silent — no
      // section, no diagnostics. Its only trace is the bootstrap tool, and only while
      // Config.bootstrapEnabled allows it.
      if (source.status !== 'missing' || !config.bootstrapEnabled) return
      const silent = { source, lastGood: null, text: '', fiber: null, watch: null, refreshing: false, again: false }
      states.set(agent, silent)
      silent.fiber = agent.ctx.inject(['tools'], scope => {
        scope.tools.register(racingCodeInitTool({ fs: ctx.fs, config, cwd, readSource, allowedModels, loadCatalog, sandboxPolicy: sessionSandboxPolicy(agent) }))
      })
      return
    }

    const state = { source, lastGood: source.status === 'ok' ? source : null, text: policyText(source), fiber: null, watch: null, refreshing: false, again: false }
    states.set(agent, state)

    state.fiber = agent.ctx.inject(['systemPrompt', 'tools'], scope => {
      scope.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: () => state.text,
      })
      scope.tools.register(flowStagesTool(() => readSource(cwd)))
      // A file that exists but does not parse keeps its diagnostic line and additionally
      // gets the bootstrap entry (preview by default; force replaces the broken file).
      if (config.bootstrapEnabled && source.status === 'invalid') {
        scope.tools.register(racingCodeInitTool({ fs: ctx.fs, config, cwd, readSource, allowedModels, loadCatalog, sandboxPolicy: sessionSandboxPolicy(agent) }))
      }
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
