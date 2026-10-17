// Contract tests for the host half (lib/index.js) with a fake ctx:
// enablement decides everything, a project with a good flow keeps the read-only surface,
// and a project without one gets exactly one tool — the bootstrap entry, which previews
// until both user gates have passed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFlow } from '../lib/flow.js'
import { apply, BOOTSTRAP_TOOL_NAME, Config, inject, resolveConfig, TOOL_NAME } from '../lib/index.js'

const CWD = '/projects/demo'
const FILE = '/projects/demo/doc/racing-code.md'
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

function makeCtx({ files = {}, watch = 'ok', agents = [], git = 'worktree-container' } = {}) {
  const handlers = new Map()
  const cleanups = []
  const logs = { warn: [] }
  const watches = []
  const writes = []
  // A faithful-enough filesystem: files and directories live in tables, and both write
  // intents are honored the way the real backend documents them.
  const state = {
    files: { ...files },
    dirs: new Set([CWD, `${CWD}/doc`, `${CWD}/.bare`, `${CWD}/.bare/worktrees`, GITDIR]),
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
    get: () => undefined,
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
    projectFlowPath: 'doc/racing-code.md',
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
  assert.equal(resolved.entry, 'design')
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
