// Contract tests for lib/sources.js: enablement decision, reading, watching.
// The filesystem is faked here; one smoke test uses the real repository file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { loadFlow, readProjectFlow, flowFilePath, watchFlow, STATUSES } from '../lib/sources.js'

function fsError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

/** Minimal ctx.fs stand-in: only resolve/readText/watch are used. */
function fakeFs({ files = {}, watch = 'ok' } = {}) {
  const calls = { resolve: 0, readText: 0, watch: 0 }
  const entries = []
  return {
    calls,
    entries,
    async resolve(path) { calls.resolve++; return { path } },
    async readText(target) {
      calls.readText++
      const value = files[target.path]
      if (value === undefined) throw fsError('FS_NOT_FOUND')
      if (value instanceof Error) throw value
      return value
    },
    async watch(target, changed, signal) {
      calls.watch++
      if (watch === 'throws') throw new Error('watch unavailable')
      const entry = { target, changed, signal, closed: false }
      entries.push(entry)
      return async () => { entry.closed = true }
    },
  }
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
].join('\n')

const CWD = '/projects/demo'
const FILE = '/projects/demo/docs/racing-code.md'
const CONFIG = { enabled: true, projectFlowPath: 'docs/racing-code.md' }

test('flowFilePath: relative resolves against the project root, absolute is kept', () => {
  assert.equal(flowFilePath(CWD, 'docs/racing-code.md'), FILE)
  assert.equal(flowFilePath('/projects/demo/', 'docs/racing-code.md'), FILE)
  assert.equal(flowFilePath(CWD, '/elsewhere/flow.md'), '/elsewhere/flow.md')
})

test('STATUSES lists every outcome loadFlow can report', () => {
  assert.deepEqual([...STATUSES].sort(), ['disabled', 'invalid', 'missing', 'ok', 'unreadable'])
})

test('readProjectFlow: a missing file is normal, not an error', async () => {
  const fs = fakeFs()
  const source = await readProjectFlow(fs, CWD, 'docs/racing-code.md')
  assert.equal(source.status, 'missing')
  assert.equal(source.file, FILE)
  assert.equal(source.text, undefined)
  assert.deepEqual(source.problems.map(p => [p.code, p.level]), [['FLOW_FILE_MISSING', 'info']])
})

test('readProjectFlow: exists but not UTF-8 text → unreadable, and an unexpected error never escapes', async () => {
  const binary = fakeFs({ files: { [FILE]: fsError('FS_NOT_TEXT') } })
  const source = await readProjectFlow(binary, CWD, 'docs/racing-code.md')
  assert.equal(source.status, 'unreadable')
  assert.deepEqual(source.problems.map(p => [p.code, p.level]), [['FLOW_FILE_UNREADABLE', 'error']])

  const broken = fakeFs({ files: { [FILE]: new Error('boom') } })
  const also = await readProjectFlow(broken, CWD, 'docs/racing-code.md')
  assert.equal(also.status, 'unreadable')
  assert.match(also.problems[0].message, /boom/)
})

test('loadFlow: disabled by config reads nothing', async () => {
  const fs = fakeFs({ files: { [FILE]: GOOD } })
  const source = await loadFlow(fs, CWD, { ...CONFIG, enabled: false })
  assert.equal(source.status, 'disabled')
  assert.equal(source.enabled, false)
  assert.equal(fs.calls.readText, 0)
  assert.deepEqual(source.problems, [])
})

test('loadFlow: missing file means the plugin is not enabled for this project', async () => {
  const source = await loadFlow(fakeFs(), CWD, CONFIG)
  assert.equal(source.status, 'missing')
  assert.equal(source.enabled, false)
  assert.equal(source.resolved, undefined)
  assert.equal(source.problems[0].code, 'FLOW_FILE_MISSING')
})

test('loadFlow: a good file enables the flow and carries lanes, loops and routes', async () => {
  const source = await loadFlow(fakeFs({ files: { [FILE]: GOOD } }), CWD, CONFIG, {
    allowedModels: [
      { provider: 'opencode-go', model: 'mimo-v2.6-pro' },
      { provider: 'opencode-go', model: 'glm-5.3-flash' },
      { provider: 'kilo', model: 'kilo-auto/free' },
    ],
  })
  assert.equal(source.status, 'ok')
  assert.equal(source.enabled, true)
  assert.equal(source.file, FILE)
  assert.deepEqual(source.problems, [])
  assert.equal(source.resolved.entry, 'start')
  assert.deepEqual(source.resolved.joins, [{ at: 'cr', lanes: ['lane-a', 'lane-b'] }])
  assert.equal(source.resolved.loops[0].kind, 'review')
  assert.equal(source.resolved.stages.find(s => s.id === 'lane-a').route.model, 'kilo-auto/free')
  assert.equal(source.resolved.stages.find(s => s.id === 'lane-a').authorized, true)
})

test('loadFlow: an invalid file is reported, not injected', async () => {
  const broken = ['```mermaid', 'flowchart TD', '  a["A"] --> b["B"]', '  a --> c["C"]', '```'].join('\n')
  const source = await loadFlow(fakeFs({ files: { [FILE]: broken } }), CWD, CONFIG)
  assert.equal(source.status, 'invalid')
  assert.equal(source.enabled, false)
  assert.ok(source.problems.some(p => p.code === 'FLOW_STAGE_FANOUT_NOT_GROUP' && p.level === 'error'))
  assert.equal(source.resolved.ok, false)
})

test('loadFlow: forwards the allowlist and the session route to the resolver', async () => {
  const denied = await loadFlow(fakeFs({ files: { [FILE]: GOOD } }), CWD, CONFIG, {
    allowedModels: [{ provider: 'opencode-go', model: 'mimo-v2.6-pro' }],
  })
  assert.equal(denied.status, 'ok')
  assert.ok(denied.problems.some(p => p.code === 'FLOW_ROUTE_NOT_AUTHORIZED'))
  assert.equal(denied.resolved.stages.find(s => s.id === 'lane-a').authorized, false)

  const unrouted = ['```mermaid', 'flowchart TD', '  a["A"] --> b["B"]', '```'].join('\n')
  const withSession = await loadFlow(fakeFs({ files: { [FILE]: unrouted } }), CWD, CONFIG, {
    sessionRoute: { provider: 'kilo', model: 'kilo-auto/free' },
  })
  assert.equal(withSession.status, 'ok')
  assert.ok(withSession.problems.some(p => p.code === 'FLOW_ROUTE_MISSING'))
  assert.equal(withSession.resolved.stages[0].fallback, true)
  assert.deepEqual(withSession.resolved.stages[0].route, { provider: 'kilo', model: 'kilo-auto/free' })
})

test('loadFlow: the Config guards are the defaults the file may override', async () => {
  const source = await loadFlow(fakeFs({ files: { [FILE]: GOOD } }), CWD, { ...CONFIG, maxReviewRounds: 5, maxLanes: 2 })
  assert.equal(source.resolved.loops[0].maxRounds, 5)

  const overriding = GOOD.replace('racing-code: 1', 'racing-code: 1\nmaxReviewRounds: 1')
  const overridden = await loadFlow(fakeFs({ files: { [FILE]: overriding } }), CWD, { ...CONFIG, maxReviewRounds: 5 })
  assert.equal(overridden.resolved.loops[0].maxRounds, 1)
})

test('watchFlow: watches with a signal, forwards changes, and disposes once', async () => {
  const fs = fakeFs()
  const seen = []
  const errors = []
  const dispose = watchFlow(fs, { path: FILE }, error => seen.push(error), error => errors.push(error))
  assert.equal(fs.calls.watch, 1)
  const entry = fs.entries[0]
  assert.equal(entry.signal.aborted, false)

  entry.changed()
  assert.deepEqual(seen, [undefined])
  assert.deepEqual(errors, [])

  await dispose()
  assert.equal(entry.signal.aborted, true)
  assert.equal(entry.closed, true)
  await dispose() // idempotent
  assert.deepEqual(errors, [])
})

test('watchFlow: an unavailable watcher degrades to a no-op and reports', async () => {
  const fs = fakeFs({ watch: 'throws' })
  const errors = []
  const dispose = watchFlow(fs, { path: FILE }, () => {}, error => errors.push(error))
  assert.equal(typeof dispose, 'function')
  await dispose()
  assert.equal(errors.length, 1)
  assert.match(String(errors[0].message), /watch unavailable/)
})

test('smoke: the repository flow file loads through the real filesystem', async () => {
  const realFs = {
    async resolve(path) { await stat(path); return { path } },
    async readText(target) { return readFile(target.path, 'utf8') },
  }
  const cwd = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
  const source = await loadFlow(realFs, cwd, CONFIG, {
    allowedModels: [
      { provider: 'opencode-go', model: 'mimo-v2.6-pro' },
      { provider: 'opencode-go', model: 'mimo-v2.6-flash' },
      { provider: 'opencode-go', model: 'glm-5.3-flash' },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      { provider: 'kilo', model: 'kilo-auto/free' },
    ],
  })
  assert.equal(source.status, 'ok')
  assert.equal(source.enabled, true)
  assert.equal(source.resolved.entry, 'plan')
  assert.deepEqual(source.resolved.joins, [{ at: 'cr', lanes: ['implement-a', 'implement-b'] }])
  assert.deepEqual(source.problems, [])
})
