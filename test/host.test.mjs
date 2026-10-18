// Contract tests for the host half (lib/index.js) with a fake ctx:
// enablement decides everything, a project with a good flow keeps the read-only surface,
// and a project without one gets exactly one tool — the bootstrap entry, which previews
// until both user gates have passed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFlow } from '../lib/flow.js'
import { apply, BOOTSTRAP_TOOL_NAME, Config, inject, resolveConfig, TOOL_NAME } from '../lib/index.js'

const CWD = '/projects/demo'
const FILE = '/projects/demo/docs/racing-code.md'
const GITDIR = '/projects/demo/.bare/worktrees/main'

/** The allowlist the fake session advertises, for the routes the tests pick. */
const ROUTES = [
  { provider: 'opencode-go', model: 'mimo-v2.6-pro' },
  { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  { provider: 'kilo', model: 'kilo-auto/free' },
]
const LANE_MODELS = { 'implement-a': 'opencode-go/deepseek-v4.1-flash', 'implement-b': 'kilo/kilo-auto/free' }

function fsError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

const GOOD = [
  '---',
  'racing-code: 1',
  'models:',
  '  start: opencode-go/mimo-v2.6-pro',
  '  lane-a: kilo/kilo-auto/free',
  '  lane-b: kilo/kilo-auto/free',
  '  cr: opencode-go/glm-5.3-flash',
  '  done: kilo/kilo-auto/free',
  '---',
  '',
  '# Flow',
  '',
  '```mermaid',
  'flowchart TD',
  '  %% entry: start',
  '  start["Start"] --> race{{"Race"}}',
  '  race --> lane-a["Lane A"]',
  '  race --> lane-b["Lane B"]',
  '  lane-a --> cr["CR"]',
  '  lane-b --> cr',
  '  cr --> verdict{"ok?"}',
  '  verdict -- "no" --> race',
  '  verdict -- "yes" --> done["Done"]',
  '```',
  '',
  '### cr',
  'Review both lanes and feed each its own problems.',
  '',
].join('\n')

/** A file that exists but does not parse: the "invalid" status the init tool serves. */
const BROKEN = ['```mermaid', 'flowchart TD', '  a["A"] --> b["B"]', '  a --> c["C"]', '```'].join('\n')

function makeAgent(cwd = CWD, { parent } = {}) {
  const registered = { sections: [], tools: [] }
  const disposals = []
  const scope = {
    systemPrompt: { section: section => { registered.sections.push(section); return () => {} } },
    tools: { register: tool => { registered.tools.push(tool); return () => {} } },
  }
  return {
    parentAgent: parent,
    session: { header: cwd === null ? {} : { cwd } }, // null = a session with no working directory
    ctx: { inject: (names, callback) => { callback(scope); return { dispose: async () => { disposals.push(names.join(',')) } } } },
    registered,
    disposals,
  }
}

function makeCtx({ files = {}, watch = 'ok', agents = [], git = 'worktree-container', services = {} } = {}) {
  const handlers = new Map()
  const cleanups = []
  const logs = { warn: [] }
  const watches = []
  const writes = []
  // A faithful-enough filesystem: files and directories live in tables, and both write
  // intents are honored the way the real backend documents them.
  const state = {
    files: { ...files },
    dirs: new Set([CWD, `${CWD}/docs`, `${CWD}/.bare`, `${CWD}/.bare/worktrees`, GITDIR]),
  }
  if (git === 'worktree-container') state.files[`${CWD}/.git`] = `gitdir: ${GITDIR}\n`
  if (git === 'git-repo') state.dirs.add(`${CWD}/.git`)
  const versions = new Map()
  let revision = 0
  const versionOf = path => versions.get(path) ?? 'v0'
  const typeOf = path => (state.files[path] !== undefined ? 'file' : state.dirs.has(path) ? 'directory' : undefined)
  const infoOf = path => {
    const type = typeOf(path)
    if (type === undefined) return undefined
    const value = state.files[path]
    return { version: versionOf(path), type, ...(typeof value === 'string' ? { size: value.length } : {}) }
  }
  const fs = {
    files: state.files,
    dirs: state.dirs,
    writes,
    calls: { resolve: 0, readText: 0, writeText: 0, watch: 0 },
    async resolve(path) { fs.calls.resolve++; return { path, targetKey: path, displayPath: path } },
    async stat(target) { return infoOf(target.path) },
    async lstat(path) { return infoOf(path) },
    async listDir(target) {
      const prefix = `${target.path}/`
      const entries = [...state.dirs, ...Object.keys(state.files)]
        .filter(entry => entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/'))
      return entries.map(entry => ({ name: entry.slice(prefix.length), type: typeOf(entry), target: { path: entry }, version: versionOf(entry) }))
    },
    async readText(target) {
      fs.calls.readText++
      const value = state.files[target.path]
      if (value === undefined) throw fsError('FS_NOT_FOUND')
      if (value instanceof Error) throw value
      return value
    },
    async writeText(target, content, expected) {
      fs.calls.writeText++
      const path = target.path
      const exists = state.files[path] !== undefined
      if (expected?.kind === 'createIfAbsent' && exists) throw fsError('FS_NOT_OBSERVED')
      if (expected?.kind === 'replaceIfVersion' && (!exists || expected.version !== versionOf(path))) throw fsError('FS_STALE_VERSION')
      const before = exists ? state.files[path] : null
      writes.push({ path, content, expected })
      state.files[path] = content
      versions.set(path, `v${++revision}`)
      return { operation: exists ? 'update' : 'create', version: versionOf(path), before: typeof before === 'string' ? before : null, after: content }
    },
    async watch(target, changed, signal) {
      fs.calls.watch++
      if (watch === 'throws') throw new Error('watch unavailable')
      const entry = { target, changed, signal, closed: false }
      watches.push(entry)
      return async () => { entry.closed = true }
    },
  }
  const ctx = {
    fs,
    logger: { warn: message => logs.warn.push(message), info: () => {}, debug: () => {} },
    get: name => services[name],
    agents: { list: () => agents },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return () => {}
    },
  }
  return {
    ctx, fs, watches, logs, cleanups,
    emit: async (event, payload) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload)
    },
    has: event => (handlers.get(event) ?? []).length > 0,
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const names = tools => tools.map(tool => tool.name)
const byId = (resolved, id) => resolved.stages.find(stage => stage.id === id)

/** A project the bootstrap tool is registered for: no flow file, a worktree container. */
async function bootstrapHarness(options = {}) {
  const harness = makeCtx(options)
  apply(harness.ctx, options.config ?? {})
  const agent = makeAgent(options.cwd === undefined ? CWD : options.cwd)
  await harness.emit('agent/created', { agent })
  const tool = agent.registered.tools.find(item => item.name === BOOTSTRAP_TOOL_NAME)
  assert.ok(tool, `${BOOTSTRAP_TOOL_NAME} must be registered`)
  return { harness, agent, tool }
}

// ─────────────────────────────── manifest surface ───────────────────────────────

test('the plugin declares its Config as a Standard Schema, with six documented fields', () => {
  assert.equal(Config['~standard'].version, 1)
  assert.equal(typeof Config['~standard'].validate, 'function')
  const parsed = Config['~standard'].validate({})
  assert.equal(parsed.issues, undefined)
  assert.deepEqual(parsed.value, {
    enabled: true,
    bootstrapEnabled: true,
    projectFlowPath: 'docs/racing-code.md',
    maxStageRepeats: 3,
    maxLanes: 4,
    maxReviewRounds: 2,
  })
  const bad = Config['~standard'].validate({ maxLanes: 0, projectFlowPath: '' })
  assert.equal(bad.value, undefined)
  assert.equal(bad.issues.length, 2)
  const badFlag = Config['~standard'].validate({ bootstrapEnabled: 'yes' })
  assert.equal(badFlag.value, undefined)
  assert.deepEqual(badFlag.issues.map(issue => issue.path), [['bootstrapEnabled']])
  assert.deepEqual(resolveConfig(undefined), parsed.value)
})

test('the host half requires only the two services it cannot work without', () => {
  assert.deepEqual([...inject].sort(), ['agents', 'fs'])
  assert.equal(TOOL_NAME, 'flow_stages')
  assert.equal(BOOTSTRAP_TOOL_NAME, 'racing_code_init')
})

// ─────────────────────────────── enablement ───────────────────────────────

test('host_missing_flow_registers_init_tool_only', async () => {
  const harness = await bootstrapHarness()
  assert.deepEqual(harness.agent.registered.sections, [], 'a project without a flow stays silent')
  assert.deepEqual(names(harness.agent.registered.tools), [BOOTSTRAP_TOOL_NAME])
  assert.ok(!names(harness.agent.registered.tools).includes(TOOL_NAME))
})

test('host_disabled_registers_nothing', async () => {
  const disabled = makeCtx({ files: { [FILE]: GOOD } })
  apply(disabled.ctx, { enabled: false })
  const off = makeAgent()
  await disabled.emit('agent/created', { agent: off })
  assert.deepEqual(off.registered.sections, [])
  assert.deepEqual(off.registered.tools, [])

  const escaped = makeCtx()
  apply(escaped.ctx, { bootstrapEnabled: false })
  const silent = makeAgent()
  await escaped.emit('agent/created', { agent: silent })
  assert.deepEqual(silent.registered.sections, [], 'bootstrapEnabled: false is the escape hatch')
  assert.deepEqual(silent.registered.tools, [])
})

test('a session without a working directory is not enabled', async () => {
  const harness = makeCtx({ files: { [FILE]: GOOD } })
  apply(harness.ctx, {})
  const agent = makeAgent(null)
  await harness.emit('agent/created', { agent })
  assert.deepEqual(agent.registered.sections, [])
  assert.deepEqual(agent.registered.tools, [])
})

test('a subagent never gets the flow section', async () => {
  const harness = makeCtx({ files: { [FILE]: GOOD } })
  apply(harness.ctx, {})
  const child = makeAgent(CWD, { parent: makeAgent() })
  await harness.emit('agent/created', { agent: child })
  assert.deepEqual(child.registered.sections, [])
})

test('an enabled project gets one section (order 700) and the read-only tool', async () => {
  const harness = makeCtx({ files: { [FILE]: GOOD } })
  apply(harness.ctx, {})
  const agent = makeAgent()
  await harness.emit('agent/created', { agent })

  assert.equal(agent.registered.sections.length, 1)
  const section = agent.registered.sections[0]
  assert.equal(section.name, 'racing-code:flow')
  assert.equal(section.order, 700)
  const text = section.text()
  assert.match(text, /Start/)
  assert.match(text, /\[race: lane-a ∥ lane-b\]/)
  assert.match(text, new RegExp(FILE))
  assert.match(text, /worktree/)
  assert.match(text, /send_message/)
  assert.match(text, /最多 2 轮/)
  assert.match(text, /kilo·kilo-auto\/free/)

  assert.equal(agent.registered.tools.length, 1)
  assert.equal(agent.registered.tools[0].name, 'flow_stages')
  assert.equal(harness.fs.calls.watch, 1)
  assert.equal(harness.watches[0].target.path, FILE)
})

test('agents that already exist at activation are handled too', async () => {
  const agent = makeAgent()
  const harness = makeCtx({ files: { [FILE]: GOOD }, agents: [agent] })
  apply(harness.ctx, {})
  await tick()
  assert.equal(agent.registered.sections.length, 1)
})

test('host_ok_flow_does_not_register_init', async () => {
  const harness = makeCtx({ files: { [FILE]: GOOD } })
  apply(harness.ctx, {})
  const agent = makeAgent()
  await harness.emit('agent/created', { agent })
  assert.deepEqual(names(agent.registered.tools), [TOOL_NAME], 'a good file is never given an overwrite entry')
})

test('host_invalid_flow_keeps_diagnostic_and_adds_init', async () => {
  const harness = makeCtx({ files: { [FILE]: BROKEN } })
  apply(harness.ctx, {})
  const agent = makeAgent()
  await harness.emit('agent/created', { agent })
  assert.equal(agent.registered.sections.length, 1, 'a broken flow still says what is wrong')
  assert.match(agent.registered.sections[0].text(), /FLOW_STAGE_FANOUT_NOT_GROUP/)
  assert.deepEqual(names(agent.registered.tools).sort(), [BOOTSTRAP_TOOL_NAME, TOOL_NAME].sort())
})

// ─────────────────────────────── the flow_stages tool ───────────────────────────────

test('flow_stages answers from disk: whole flow, one stage, unknown stage, bad args', async () => {
  const harness = makeCtx({ files: { [FILE]: GOOD } })
  apply(harness.ctx, {})
  const agent = makeAgent()
  await harness.emit('agent/created', { agent })
  const tool = agent.registered.tools[0]
  const exec = { signal: undefined }

  const whole = await tool.execute({}, exec)
  assert.match(whole.summary, /入口 start/)
  assert.match(whole.details, /```mermaid/)
  assert.match(whole.details, /racing\/lane-a/)
  assert.match(whole.details, /子代理显示名：lane-a=lane-kilo-auto\/free/)
  assert.deepEqual(whole.problems, [])

  const one = await tool.execute({ stage: 'cr' }, exec)
  assert.match(one.details, /Review both lanes/)
  assert.deepEqual(one.problems, [])

  const unknown = await tool.execute({ stage: 'nope' }, exec)
  assert.match(unknown.summary, /nope/)
  assert.ok(unknown.problems.some(line => line.includes('lane-a')))

  await assert.rejects(() => tool.execute({ stage: 42 }, exec), /stage/)
})

test('flow_stages reports a deleted or broken file instead of inventing a flow', async () => {
  const harness = makeCtx({ files: { [FILE]: GOOD } })
  apply(harness.ctx, {})
  const agent = makeAgent()
  await harness.emit('agent/created', { agent })
  const tool = agent.registered.tools[0]

  delete harness.fs.files
  harness.fs.calls.readText = 0
  const files = harness.fs
  files.readText = async () => { throw fsError('FS_NOT_FOUND') }
  const gone = await tool.execute({}, {})
  assert.match(gone.summary, /未启用|没有/)
  assert.equal(gone.problems.length, 1)

  files.readText = async () => ['```mermaid', 'flowchart TD', '  a["A"] --> b["B"]', '  a --> c["C"]', '```'].join('\n')
  const broken = await tool.execute({}, {})
  assert.match(broken.summary, /不可用|失败/)
  assert.ok(broken.problems.some(line => line.includes('FLOW_STAGE_FANOUT_NOT_GROUP')))
})

// ─────────────────────────────── the bootstrap tool ───────────────────────────────

test('host_init_defaults_to_preview', async () => {
  const { harness, tool } = await bootstrapHarness()
  const result = await tool.execute({}, {})
  assert.equal(result.wrote, false)
  assert.equal(harness.fs.calls.writeText, 0, 'no argument at all means preview only')
  assert.equal(result.file, FILE)
})

test('host_init_preview_returns_template_and_nodes', async () => {
  const { tool } = await bootstrapHarness()
  const result = await tool.execute({}, {})

  assert.match(result.template, /^laneDir: branch$/m, 'this project is a worktree container')
  const resolved = resolveFlow(result.template, { allowedModels: ROUTES })
  assert.deepEqual(resolved.problems, [])
  assert.equal(resolved.entry, 'plan')
  assert.equal(byId(resolved, 'implement-a').lane.worktree, 'racing/implement-a')

  assert.equal(result.nodes.length, resolved.stages.length)
  for (const node of result.nodes) {
    assert.equal(node.default, 'session')
    assert.ok(Array.isArray(node.candidates))
  }
  assert.ok(Array.isArray(result.plan) && result.plan.length > 0)
  assert.ok(result.protocol.length >= 9)
  assert.match(result.summary, /\S/)
  assert.match(result.nextStep, /新开会话/)
})

test('host_init_write_requires_lane_choices', async () => {
  const { harness, tool } = await bootstrapHarness()
  const result = await tool.execute({ write: true, models: {} }, {})
  assert.equal(result.wrote, false, 'gate 2 must be complete before anything lands')
  assert.equal(harness.fs.calls.writeText, 0)
  assert.ok(result.diagnostics.some(line => line.includes('BOOTSTRAP_CHOICE_REQUIRED')), result.diagnostics.join(' | '))
  assert.ok(result.template.includes('```mermaid'), 'the preview text still comes back')
})

test('host_init_write_creates_with_create_if_absent', async () => {
  const { harness, tool } = await bootstrapHarness()
  const result = await tool.execute({ write: true, models: LANE_MODELS }, {})

  assert.equal(result.wrote, true)
  assert.equal(harness.fs.writes.length, 1)
  assert.equal(harness.fs.writes[0].path, FILE)
  assert.equal(harness.fs.writes[0].content, result.template, 'preview and write are the same text')
  assert.deepEqual(harness.fs.writes[0].expected, { kind: 'createIfAbsent' })

  const resolved = resolveFlow(result.template, { allowedModels: ROUTES })
  assert.deepEqual(resolved.problems.map(problem => problem.code), [])
  assert.equal(byId(resolved, 'implement-a').route.model, 'deepseek-v4.1-flash')
  assert.equal(byId(resolved, 'implement-b').route.model, 'kilo-auto/free')
})

test('host_init_refuses_existing_without_force', async () => {
  const { harness, tool } = await bootstrapHarness({ files: { [FILE]: BROKEN } })
  const result = await tool.execute({ write: true, models: LANE_MODELS }, {})
  assert.equal(result.wrote, false)
  assert.equal(harness.fs.calls.writeText, 0, 'the existing file is never touched')
  assert.equal(harness.fs.files[FILE], BROKEN)
  assert.ok(result.diagnostics.some(line => line.includes('BOOTSTRAP_FILE_EXISTS')), result.diagnostics.join(' | '))
  assert.match(result.diagnostics.join('\n'), /force/)
})

test('host_init_force_uses_replace_if_version', async () => {
  const { harness, tool } = await bootstrapHarness({ files: { [FILE]: BROKEN } })
  const result = await tool.execute({ write: true, force: true, models: LANE_MODELS }, {})

  assert.equal(result.wrote, true)
  assert.equal(harness.fs.writes.length, 1)
  assert.equal(harness.fs.writes[0].expected.kind, 'replaceIfVersion')
  assert.equal(harness.fs.writes[0].expected.version, 'v0', 'the version stat just reported')
  assert.match(harness.fs.files[FILE], /```mermaid/, 'the broken file is replaced')
})

test('host_init_reports_restart_required', async () => {
  const { tool } = await bootstrapHarness()
  const result = await tool.execute({ write: true, models: LANE_MODELS }, {})
  assert.equal(result.wrote, true)
  assert.ok(result.diagnostics.some(line => line.includes('BOOTSTRAP_RESTART_REQUIRED')), result.diagnostics.join(' | '))
  assert.match(result.nextStep, /新开会话/)
  assert.match(result.nextStep, /生效/)
})

test('host_init_stamps_the_session_sandbox_policy_on_write', async () => {
  const { harness, agent, tool } = await bootstrapHarness()
  const requests = []
  const policy = { mode: 'danger-full-access', workspaceRoot: CWD }
  harness.ctx.get = name => name === 'sandboxPolicy'
    ? { resolve: request => { requests.push(request); return policy } }
    : undefined
  let stamped = 'unset'
  harness.fs.writeText = async (target, content, expected, signal, sandboxPolicy) => {
    stamped = sandboxPolicy
    return { operation: 'create', version: 'v1', before: null, after: content }
  }

  const result = await tool.execute({ write: true, models: LANE_MODELS }, {})
  assert.equal(result.wrote, true)
  assert.deepEqual(requests[0], { session: agent.session }, 'the policy is resolved for THIS session')
  assert.equal(stamped, policy, 'the resolved session policy reaches fs.writeText')
})

test('host_init_passes_through_a_narrower_session_policy', async () => {
  const { harness, tool } = await bootstrapHarness()
  const policy = { mode: 'workspace-write', workspaceRoot: CWD + '/narrow' }
  harness.ctx.get = name => name === 'sandboxPolicy'
    ? { resolve: () => policy }
    : undefined
  let stamped = 'unset'
  harness.fs.writeText = async (target, content, expected, signal, sandboxPolicy) => {
    stamped = sandboxPolicy
    return { operation: 'create', version: 'v1', before: null, after: content }
  }

  const result = await tool.execute({ write: true, models: LANE_MODELS }, {})
  assert.equal(result.wrote, true)
  assert.equal(stamped, policy, 'the session mode is passed through unchanged, not hard-coded')
})

test('host_init_degrades_when_the_policy_resolver_throws', async () => {
  const { harness, tool } = await bootstrapHarness()
  harness.ctx.get = name => name === 'sandboxPolicy'
    ? { resolve: () => { throw new Error('policy service unavailable') } }
    : undefined
  let stamped = 'unset'
  harness.fs.writeText = async (target, content, expected, signal, sandboxPolicy) => {
    stamped = sandboxPolicy
    return { operation: 'create', version: 'v1', before: null, after: content }
  }

  const result = await tool.execute({ write: true, models: LANE_MODELS }, {})
  assert.equal(result.wrote, true, 'a throwing resolver must not block the write')
  assert.equal(stamped, undefined, 'a failed resolution degrades to the backend default')
  assert.ok(harness.logs.warn.some(line => /sandbox/i.test(line)), harness.logs.warn.join(' | '))
})

test('host_init_sandbox_denial_returns_text', async () => {
  const { harness, tool } = await bootstrapHarness()
  harness.fs.writeText = async () => { throw fsError('FS_SANDBOX_DENIED') }
  const result = await tool.execute({ write: true, models: LANE_MODELS }, {})

  assert.equal(result.wrote, false, 'a denied write is never reported as done')
  assert.ok(result.diagnostics.some(line => line.includes('BOOTSTRAP_WRITE_FAILED')), result.diagnostics.join(' | '))
  assert.ok(result.diagnostics.some(line => line.includes('FS_SANDBOX_DENIED')), 'the FsError code travels back')
  assert.match(result.template, /```mermaid/, 'the full text comes back so it can be created by hand')
})

// ─────────────────────────────── refresh and teardown ───────────────────────────────

test('editing the file refreshes the section, keeping the last good flow when it breaks', async () => {
  const harness = makeCtx({ files: { [FILE]: GOOD } })
  apply(harness.ctx, {})
  const agent = makeAgent()
  await harness.emit('agent/created', { agent })
  const section = agent.registered.sections[0]
  assert.match(section.text(), /Start/)

  harness.fs.readText = async () => GOOD.replace('start["Start"]', 'start["Start (v2)"]')
  harness.watches[0].changed()
  await tick()
  assert.match(section.text(), /Start \(v2\)/)

  harness.fs.readText = async () => ['```mermaid', 'flowchart TD', '  a["A"] --> b["B"]', '  a --> c["C"]', '```'].join('\n')
  harness.watches[0].changed()
  await tick()
  assert.match(section.text(), /Start \(v2\)/, 'keeps the last good flow')
  assert.match(section.text(), /FLOW_STAGE_FANOUT_NOT_GROUP/)

  harness.fs.readText = async () => { throw fsError('FS_NOT_FOUND') }
  harness.watches[0].changed()
  await tick()
  assert.match(section.text(), /FLOW_FILE_MISSING_AFTER_ENABLE/)
  assert.ok(!section.text().includes('Start (v2)'), 'a deleted file stops showing the old flow')
})

test('disposing the agent (or the plugin) releases the watch and the registrations', async () => {
  const harness = makeCtx({ files: { [FILE]: GOOD } })
  apply(harness.ctx, {})
  const agent = makeAgent()
  await harness.emit('agent/created', { agent })
  await harness.emit('agent/disposed', { agent })
  assert.equal(harness.watches[0].signal.aborted, true)
  assert.equal(agent.disposals.length, 1)

  const second = makeAgent()
  await harness.emit('agent/created', { agent: second })
  for (const cleanup of harness.cleanups) await cleanup()
  assert.equal(harness.watches[1].signal.aborted, true)
})

test('an unavailable watcher does not block enabling, and is reported', async () => {
  const harness = makeCtx({ files: { [FILE]: GOOD }, watch: 'throws' })
  apply(harness.ctx, {})
  const agent = makeAgent()
  await harness.emit('agent/created', { agent })
  await tick()
  assert.equal(agent.registered.sections.length, 1)
  assert.equal(harness.logs.warn.length, 1)
  assert.match(String(harness.logs.warn[0]), /watch unavailable/)
})

test('an unreadable file is reported as a diagnostic, not silence', async () => {
  const harness = makeCtx({ files: { [FILE]: fsError('FS_NOT_TEXT') } })
  apply(harness.ctx, {})
  const agent = makeAgent()
  await harness.emit('agent/created', { agent })
  assert.equal(agent.registered.sections.length, 1)
  assert.match(agent.registered.sections[0].text(), /FLOW_FILE_UNREADABLE/)
})

// ─────────────────────── the DSH side: directory, allowlist, runtime (plan §3 + §5) ───────────────────────

/** The llm directory the fake DSH advertises, per provider, in directory order. */
const DIRECTORY = {
  'opencode-go': ['deepseek-v4.1-flash', 'glm-5.3-flash'],
  kilo: ['kilo-auto/free'],
}

/**
 * The DSH services racing-code reads: the subagent allowlist, the settings writer behind it
 * and the llm directory. updates records every settings mutation the plugin makes.
 */
function dshServices({ allowed = ROUTES, enabled = true, conflict = 0, conflictAdds = [], settings = true, directory = DIRECTORY } = {}) {
  const updates = []
  let routes = allowed.map(route => ({ ...route }))
  let current = directory
  let revision = 7
  let conflictsLeft = conflict
  const service = {
    describe: () => [{
      ns: 'subagent-model-selection-settings',
      revision,
      value: { enabled, allowedModels: routes.map(route => ({ ...route })) },
    }],
    async update(ns, patch, expected) {
      if (conflictsLeft > 0) {
        conflictsLeft--
        revision++
        // A real conflict is a concurrent *write*: the other writer may have appended a
        // route, and the retry must keep it instead of overwriting it with a stale base.
        for (const route of conflictAdds) {
          if (!routes.some(entry => entry.provider === route.provider && entry.model === route.model)) routes.push({ ...route })
        }
        const error = new Error('settings namespace changed since it was read')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
      updates.push({ ns, patch, expected })
      routes = patch.allowedModels.map(route => ({ ...route }))
      revision++
    },
  }
  const services = {
    subagentModelSelection: { current: () => ({ enabled, allowedModels: routes.map(route => ({ ...route })) }) },
    llm: {
      listProviders: () => Object.keys(current).map(id => ({ id, name: id })),
      listModels: async provider => (current[provider] ?? []).map(id => ({ provider, id, name: id })),
    },
  }
  if (settings) services.settings = service
  return { services, updates, setDirectory: next => { current = next } }
}

const keys = list => list.map(route => route.provider + '/' + route.model)
/** One pick outside the allowlist (glm-5.3-flash) and one inside it (kilo-auto/free). */
const UNALLOWED_PICK = { 'implement-a': 'opencode-go/glm-5.3-flash', 'implement-b': 'kilo/kilo-auto/free' }

test('host_init_tabs_offer_the_whole_directory_and_mark_unauthorized_models', async () => {
  const dsh = dshServices()
  const { harness, tool } = await bootstrapHarness({ services: dsh.services })
  const result = await tool.execute({}, {})

  const node = result.nodes.find(item => item.id === 'implement-a')
  assert.deepEqual(keys(node.candidates),
    ['opencode-go/deepseek-v4.1-flash', 'opencode-go/glm-5.3-flash', 'kilo/kilo-auto/free'],
    'the whole directory, in directory order')
  assert.equal(node.candidates.find(candidate => candidate.model === 'glm-5.3-flash').authorized, false)
  assert.equal(node.candidates.find(candidate => candidate.model === 'glm-5.3-flash').willAllowlist, true)

  const rendered = tool.output.render({}, result)[0].text
  assert.match(rendered, /opencode-go\/glm-5\.3-flash/)
  assert.match(rendered, /未授权（选中后自动加入白名单）/)
  assert.equal(harness.fs.calls.writeText, 0, 'a preview writes nothing, including the allowlist')
  assert.deepEqual(dsh.updates, [])
})

test('host_init_write_appends_the_picked_route_to_the_allowlist', async () => {
  const dsh = dshServices()
  const { harness, tool } = await bootstrapHarness({ services: dsh.services })
  const result = await tool.execute({ write: true, models: UNALLOWED_PICK }, {})

  assert.equal(result.wrote, true)
  assert.equal(dsh.updates.length, 1, 'one revision-fenced append')
  assert.equal(dsh.updates[0].ns, 'subagent-model-selection-settings')
  assert.equal(dsh.updates[0].expected, 7, 'the revision describe() returned')
  assert.deepEqual(keys(dsh.updates[0].patch.allowedModels), [
    'opencode-go/mimo-v2.6-pro', 'opencode-go/deepseek-v4.1-flash', 'kilo/kilo-auto/free', 'opencode-go/glm-5.3-flash',
  ], 'append-only: existing entries keep their order')
  assert.ok(result.diagnostics.some(line => line.includes('BOOTSTRAP_ALLOWLIST_ADDED')), result.diagnostics.join(' | '))
  assert.equal(harness.fs.writes.length, 1, 'the flow file still lands')
})

test('host_init_write_appends_nothing_when_the_picks_are_already_allowed', async () => {
  const dsh = dshServices()
  const { tool } = await bootstrapHarness({ services: dsh.services })
  const result = await tool.execute({ write: true, models: LANE_MODELS }, {})
  assert.equal(result.wrote, true)
  assert.deepEqual(dsh.updates, [], 'nothing to append')
  assert.ok(result.diagnostics.some(line => line.includes('BOOTSTRAP_ALLOWLIST_NOOP')), result.diagnostics.join(' | '))
})

test('host_init_retries_once_when_the_allowlist_moved_under_it', async () => {
  const dsh = dshServices({ conflict: 1 })
  const { tool } = await bootstrapHarness({ services: dsh.services })
  const result = await tool.execute({ write: true, models: UNALLOWED_PICK }, {})
  assert.equal(result.wrote, true)
  assert.equal(dsh.updates.length, 1, 'the retry lands')
  assert.equal(dsh.updates[0].expected, 8, 'the revision re-read after the conflict')
  assert.ok(result.diagnostics.some(line => line.includes('BOOTSTRAP_ALLOWLIST_ADDED')), result.diagnostics.join(' | '))
})

test('host_init_reports_a_persistent_allowlist_conflict_and_still_writes_the_flow', async () => {
  const dsh = dshServices({ conflict: 5 })
  const { harness, tool } = await bootstrapHarness({ services: dsh.services })
  const result = await tool.execute({ write: true, models: UNALLOWED_PICK }, {})
  assert.equal(result.wrote, true, 'the allowlist never blocks the flow file')
  assert.deepEqual(dsh.updates, [])
  assert.ok(result.diagnostics.some(line => line.includes('BOOTSTRAP_ALLOWLIST_CONFLICT')), result.diagnostics.join(' | '))
  assert.equal(harness.fs.writes.length, 1)
})

test('host_init_degrades_without_a_settings_service', async () => {
  const dsh = dshServices({ settings: false })
  const { harness, tool } = await bootstrapHarness({ services: dsh.services })
  const result = await tool.execute({ write: true, models: UNALLOWED_PICK }, {})
  assert.equal(result.wrote, true)
  assert.ok(result.diagnostics.some(line => line.includes('BOOTSTRAP_ALLOWLIST_UNAVAILABLE')), result.diagnostics.join(' | '))
  assert.equal(harness.fs.writes.length, 1)
})

test('host_init_does_not_allowlist_when_model_selection_is_disabled', async () => {
  const dsh = dshServices({ enabled: false })
  const { tool } = await bootstrapHarness({ services: dsh.services })
  const result = await tool.execute({ write: true, models: UNALLOWED_PICK }, {})
  assert.equal(result.wrote, true)
  assert.deepEqual(dsh.updates, [], 'a disabled allowlist imposes no policy, so there is nothing to append')
  assert.ok(result.diagnostics.some(line => line.includes('BOOTSTRAP_ALLOWLIST_DISABLED')), result.diagnostics.join(' | '))
})

test('host_init_only_touches_the_allowlist_after_every_check_passes', async () => {
  const dsh = dshServices()
  const { harness, tool } = await bootstrapHarness({ services: dsh.services })

  const refused = await tool.execute({ write: true, models: {} }, {})
  assert.equal(refused.wrote, false)
  assert.equal(harness.fs.calls.writeText, 0)
  assert.deepEqual(dsh.updates, [], 'a refusal has zero side effects')

  // The successful call does append, so the guard above is not vacuous.
  const written = await tool.execute({ write: true, models: UNALLOWED_PICK }, {})
  assert.equal(written.wrote, true)
  assert.equal(dsh.updates.length, 1, 'exactly one append, from the successful call')
})

// ─────────────────────────── runtime resolution in a live session (plan §5) ───────────────────────────

/** A flow whose lanes carry no models at all: exactly what plan §5 makes the normal shape. */
const RUNTIME_FLOW = [
  '---',
  'racing-code: 1',
  'models:',
  '  start: session',
  '  cr: session',
  '  done: session',
  '---',
  '',
  '# Flow',
  '',
  '```mermaid',
  'flowchart TD',
  '  %% entry: start',
  '  start["Start"] --> race{{"Race"}}',
  '  race --> lane-a["Lane A"]',
  '  race --> lane-b["Lane B"]',
  '  lane-a --> cr["CR"]',
  '  lane-b --> cr',
  '  cr --> done["Done"]',
  '```',
  '',
].join('\n')

/** A project with a working flow file: the read-only surface, no bootstrap entry. */
async function flowHarness(options = {}) {
  const harness = makeCtx(options)
  apply(harness.ctx, options.config ?? {})
  const agent = makeAgent(options.cwd === undefined ? CWD : options.cwd)
  await harness.emit('agent/created', { agent })
  const tool = agent.registered.tools.find(item => item.name === TOOL_NAME)
  assert.ok(tool, TOOL_NAME + ' must be registered')
  return { harness, agent, tool }
}

test('host_runtime_routes_are_resolved_from_the_directory_not_the_file', async () => {
  const dsh = dshServices()
  const { agent, tool } = await flowHarness({ files: { [FILE]: RUNTIME_FLOW }, services: dsh.services })
  const result = await tool.execute({}, {})

  assert.match(result.details, /lane-a=opencode-go·deepseek-v4\.1-flash（运行时解析）/)
  assert.match(result.details, /lane-b=kilo·kilo-auto\/free（运行时解析）/)
  assert.deepEqual(result.problems, [], 'a resolved lane is no longer a FLOW_ROUTE_MISSING warning')
  assert.match(agent.registered.sections[0].text(), /（运行时解析）/)
})

test('host_runtime_pool_never_uses_a_model_outside_the_allowlist', async () => {
  const dsh = dshServices({ allowed: [{ provider: 'opencode-go', model: 'glm-5.3-flash' }] })
  const { tool } = await flowHarness({ files: { [FILE]: RUNTIME_FLOW }, services: dsh.services })
  const result = await tool.execute({}, {})

  assert.match(result.details, /lane-a=opencode-go·glm-5\.3-flash（运行时解析）/)
  assert.match(result.details, /lane-b=（用当前会话模型委派）/, 'the second lane has no second authorized route')
  assert.ok(result.problems.some(line => line.includes('FLOW_ROUTE_UNRESOLVED')), result.problems.join(' | '))
})

test('host_llm_adapters_updated_re_resolves_the_routes', async () => {
  const dsh = dshServices()
  const { agent, harness } = await flowHarness({ files: { [FILE]: RUNTIME_FLOW }, services: dsh.services })
  assert.match(agent.registered.sections[0].text(), /deepseek-v4\.1-flash/)

  // The refresh must be observable, so the new directory reorders the pool — and every entry
  // stays inside the allowlist (the pool is directory ∩ allowlist, plan §5): glm-5.3-flash is
  // advertised but not authorized, so it can never be assigned.
  dsh.setDirectory({ 'opencode-go': ['mimo-v2.6-pro'], kilo: ['kilo-auto/free'] })
  await harness.emit('llm/adapters-updated')
  await tick()
  await tick()
  assert.match(agent.registered.sections[0].text(), /lane-a=opencode-go·mimo-v2\.6-pro（运行时解析）/)
  assert.match(agent.registered.sections[0].text(), /lane-b=kilo·kilo-auto\/free（运行时解析）/)
})


test('host_init_keeps_a_concurrent_allowlist_change_when_it_retries', async () => {
  // The conflict is not just a revision bump: another writer appends a route in between. The
  // revision fence protects the write, the re-read protects the content — a retry that writes
  // the first read's array would silently drop the concurrent addition.
  const dsh = dshServices({ conflict: 1, conflictAdds: [{ provider: 'other-vendor', model: 'x-large' }] })
  const { tool } = await bootstrapHarness({ services: dsh.services })
  const result = await tool.execute({ write: true, models: UNALLOWED_PICK }, {})

  assert.equal(result.wrote, true)
  assert.equal(dsh.updates.length, 1, 'the retry lands exactly once')
  assert.deepEqual(keys(dsh.updates[0].patch.allowedModels), [
    'opencode-go/mimo-v2.6-pro', 'opencode-go/deepseek-v4.1-flash', 'kilo/kilo-auto/free',
    'other-vendor/x-large', 'opencode-go/glm-5.3-flash',
  ], 'the concurrent addition survives the retry')
  assert.ok(result.diagnostics.some(line => line.includes('BOOTSTRAP_ALLOWLIST_ADDED')), result.diagnostics.join(' | '))
})

