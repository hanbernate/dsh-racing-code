// Contract tests for the host half (lib/index.js) with a fake ctx:
// enablement decides everything, and a project without a flow registers nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, inject, resolveConfig, TOOL_NAME } from '../lib/index.js'

const CWD = '/projects/demo'
const FILE = '/projects/demo/doc/racing-code.md'

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

function makeCtx({ files = {}, watch = 'ok', agents = [] } = {}) {
  const handlers = new Map()
  const cleanups = []
  const logs = { warn: [] }
  const watches = []
  const fs = {
    calls: { resolve: 0, readText: 0, watch: 0 },
    async resolve(path) { fs.calls.resolve++; return { path } },
    async readText(target) {
      fs.calls.readText++
      const value = files[target.path]
      if (value === undefined) throw fsError('FS_NOT_FOUND')
      if (value instanceof Error) throw value
      return value
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

// ─────────────────────────────── manifest surface ───────────────────────────────

test('the plugin declares its Config as a Standard Schema, with five documented fields', () => {
  assert.equal(Config['~standard'].version, 1)
  assert.equal(typeof Config['~standard'].validate, 'function')
  const parsed = Config['~standard'].validate({})
  assert.equal(parsed.issues, undefined)
  assert.deepEqual(parsed.value, {
    enabled: true,
    projectFlowPath: 'doc/racing-code.md',
    maxStageRepeats: 3,
    maxLanes: 4,
    maxReviewRounds: 2,
  })
  const bad = Config['~standard'].validate({ maxLanes: 0, projectFlowPath: '' })
  assert.equal(bad.value, undefined)
  assert.equal(bad.issues.length, 2)
  assert.deepEqual(resolveConfig(undefined), parsed.value)
})

test('the host half requires only the two services it cannot work without', () => {
  assert.deepEqual([...inject].sort(), ['agents', 'fs'])
  assert.equal(TOOL_NAME, 'flow_stages')
})

// ─────────────────────────────── enablement ───────────────────────────────

test('a project without a flow file registers nothing at all', async () => {
  const harness = makeCtx()
  apply(harness.ctx, {})
  const agent = makeAgent()
  await harness.emit('agent/created', { agent })
  assert.deepEqual(agent.registered.sections, [])
  assert.deepEqual(agent.registered.tools, [])
  assert.equal(harness.fs.calls.watch, 0)
})

test('a disabled plugin registers nothing, even with a file present', async () => {
  const harness = makeCtx({ files: { [FILE]: GOOD } })
  apply(harness.ctx, { enabled: false })
  const agent = makeAgent()
  await harness.emit('agent/created', { agent })
  assert.deepEqual(agent.registered.sections, [])
  assert.deepEqual(agent.registered.tools, [])
})

test('a session without a working directory is not enabled', async () => {
  const harness = makeCtx({ files: { [FILE]: GOOD } })
  apply(harness.ctx, {})
  const agent = makeAgent(null)
  await harness.emit('agent/created', { agent })
  assert.deepEqual(agent.registered.sections, [])
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

// ─────────────────────────────── the tool ───────────────────────────────

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
