// CONTRACT (RED): per-project configuration in <cwd>/.dsh/racing-code.yml.
//
// Precedence
//   flowPath / workBranch : project config  >  global Config  >  defaults
//   guards                : flow front matter > project config > global Config
//   enabled               : global false is a hard master switch (reads nothing);
//                           a project may opt out with enabled: false.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadProjectConfig, loadFlow } from '../lib/sources.js'

const CWD = '/projects/demo'
const CONFIG_FILE = '/projects/demo/.dsh/racing-code.yml'
const GLOBAL_FLOW = '/projects/demo/legacy/flow.md'
const DEFAULT_FLOW = '/projects/demo/docs/racing-code.md'
const CUSTOM_FLOW = '/projects/demo/flows/custom.md'

const FLOW = [
  '---', 'racing-code: 1', 'models:',
  '  plan: session', '  impl-a: session', '  impl-b: session', '  cr: session',
  '---', '',
  '```mermaid',
  'flowchart TD',
  '  %% entry: plan',
  '  plan --> race{{"race"}}',
  '  race --> impl-a["A"]',
  '  race --> impl-b["B"]',
  '  impl-a --> cr["CR"]',
  '  impl-b --> cr',
  '  cr --> verdict{"ok?"}',
  '  verdict -- "no" --> race',
  '  verdict -- "yes" --> done["done"]',
  '```',
].join('\n')

function fs(files = {}) {
  const calls = { readText: 0 }
  const notFound = () => { const error = new Error('FS_NOT_FOUND'); error.code = 'FS_NOT_FOUND'; return error }
  return {
    calls,
    async resolve(path) { return { path } },
    async readText(target) {
      calls.readText++
      const value = files[target.path]
      if (value === undefined) throw notFound()
      return value
    },
  }
}

test('loadProjectConfig: a missing file is empty, not an error', async () => {
  const result = await loadProjectConfig(fs(), CWD)
  assert.equal(result.file, CONFIG_FILE)
  assert.deepEqual(result.config, {})
  assert.deepEqual(result.problems, [])
})

test('loadProjectConfig: parses flowPath, workBranch, enabled, bootstrapEnabled and guards', async () => {
  const text = [
    'racing-code: 1',
    'enabled: true',
    'bootstrapEnabled: false',
    'flowPath: docs/racing-code.md',
    'workBranch: "0.0.x"',
    'maxLanes: 3',
  ].join('\n')
  const result = await loadProjectConfig(fs({ [CONFIG_FILE]: text }), CWD)
  assert.deepEqual(result.problems, [])
  assert.equal(result.config.flowPath, 'docs/racing-code.md')
  assert.equal(result.config.workBranch, '0.0.x')
  assert.equal(result.config.enabled, true)
  assert.equal(result.config.bootstrapEnabled, false)
  assert.equal(result.config.maxLanes, 3)
})

test('loadFlow: the project flowPath beats the global projectFlowPath', async () => {
  const files = {
    [CONFIG_FILE]: 'flowPath: flows/custom.md\nworkBranch: wb\n',
    [CUSTOM_FLOW]: FLOW,
    [GLOBAL_FLOW]: FLOW,
  }
  const source = await loadFlow(fs(files), CWD, { enabled: true, projectFlowPath: 'legacy/flow.md' })
  assert.equal(source.status, 'ok')
  assert.equal(source.file, CUSTOM_FLOW)
  const lane = source.resolved.stages.find(stage => stage.id === 'impl-a').lane
  assert.equal(lane.branch, 'wb-racing/impl-a')
})

test('loadFlow: without a project config the global path is the fallback', async () => {
  const source = await loadFlow(fs({ [GLOBAL_FLOW]: FLOW }), CWD, { enabled: true, projectFlowPath: 'legacy/flow.md' })
  assert.equal(source.status, 'ok')
  assert.equal(source.file, GLOBAL_FLOW)
})

test('loadFlow: a project may opt out with enabled: false, but not revive a globally disabled plugin', async () => {
  const files = { [CONFIG_FILE]: 'enabled: false\n', [DEFAULT_FLOW]: FLOW }
  const off = await loadFlow(fs(files), CWD, { enabled: true })
  assert.equal(off.status, 'disabled')
  assert.equal(off.enabled, false)

  const master = fs(files)
  const silent = await loadFlow(master, CWD, { enabled: false })
  assert.equal(silent.status, 'disabled')
  assert.equal(master.calls.readText, 0, 'a global kill switch reads nothing')
})

test('loadFlow: project guards beat global guards, flow front matter beats both', async () => {
  const files = { [CONFIG_FILE]: 'maxReviewRounds: 1\n', [DEFAULT_FLOW]: FLOW }
  const project = await loadFlow(fs(files), CWD, { enabled: true, maxReviewRounds: 5 })
  assert.equal(project.resolved.loops[0].maxRounds, 1)

  const override = FLOW.replace('racing-code: 1', 'racing-code: 1\nmaxReviewRounds: 3')
  const withFile = await loadFlow(fs({ [CONFIG_FILE]: 'maxReviewRounds: 1\n', [DEFAULT_FLOW]: override }), CWD, { enabled: true, maxReviewRounds: 5 })
  assert.equal(withFile.resolved.loops[0].maxRounds, 3)
})

test('loadFlow: a broken project config warns and falls back to the defaults', async () => {
  const files = { [CONFIG_FILE]: 'enabled: maybe\n', [DEFAULT_FLOW]: FLOW }
  const source = await loadFlow(fs(files), CWD, { enabled: true })
  assert.equal(source.status, 'ok')
  assert.equal(source.file, DEFAULT_FLOW)
  assert.ok(source.problems.some(problem => problem.code === 'FLOW_PROJECT_CONFIG_INVALID'), JSON.stringify(source.problems))
})
