// Contract tests for the pure bootstrap layer (lib/bootstrap.js).
// Written against the interface in doc/bootstrap.md §3.2 and §4 — they must not be
// adjusted to fit an implementation: the generator's red line is "the text resolves with
// zero errors", and no route is ever picked for the user.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFlow } from '../lib/flow.js'
import {
  bootstrapProtocol, buildPlan, buildRouteChoices, checkBootstrapTarget, renderBootstrapTemplate,
} from '../lib/bootstrap.js'

const ALLOWED = [
  { provider: 'opencode-go', model: 'mimo-v2.6-pro' },
  { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  { provider: 'kilo', model: 'kilo-auto/free' },
]
/** The llm directory: two of these are authorized, one is not, one is a route nobody allowed. */
const CATALOG = [
  { provider: 'opencode-go', model: 'deepseek-v4.1-flash', note: '与 contract-tests 同款' },
  { provider: 'opencode-go', model: 'glm-5.3-flash' },
  { provider: 'kilo', model: 'kilo-auto/free' },
  { provider: 'other-vendor', model: 'x-large' },
]
const STAGES = [
  { id: 'design', label: '设计', brief: '产出设计文档，不写代码' },
  { id: 'contract-tests', label: '接口 + 测试' },
  { id: 'implement-a', label: '实现 A' },
  { id: 'implement-b', label: '实现 B' },
  { id: 'cr', label: 'CR 评审' },
  { id: 'commit', label: '提交' },
]
const LANES = [{ id: 'implement-a', joinAt: 'cr' }, { id: 'implement-b', joinAt: 'cr' }]

const key = route => `${route.provider}/${route.model}`
const codes = (resolved, level) => resolved.problems.filter(p => level === undefined || p.level === level).map(p => p.code)
const byId = (resolved, id) => resolved.stages.find(stage => stage.id === id)

/** Facts for buildPlan: a ready-to-bootstrap worktree container unless overridden. */
function facts(overrides = {}) {
  return {
    file: '/projects/demo/doc/racing-code.md',
    fileExists: false,
    parentExists: true,
    gitLayout: 'worktree-container',
    laneDir: 'branch',
    gitignore: null,
    nodes: buildRouteChoices({ allowedModels: ALLOWED, catalog: CATALOG, stages: STAGES, lanes: LANES }).nodes,
    candidates: CATALOG,
    ...overrides,
  }
}

function assertPlanShape(plan) {
  assert.ok(Array.isArray(plan) && plan.length > 0, 'the plan is never empty')
  for (const item of plan) {
    assert.equal(typeof item.item, 'string')
    assert.ok(item.item.length > 0)
    assert.ok(['ok', 'warn', 'blocked'].includes(item.status), `bad status ${item.status}`)
    assert.ok(typeof item.detail === 'string' && item.detail.length > 0)
    if (item.fix !== undefined) assert.equal(typeof item.fix, 'string')
  }
}

const planText = plan => plan.map(item => `${item.detail} ${item.fix ?? ''}`).join('\n')

// ─────────────────────────────── the generated file ───────────────────────────────

test('bootstrap_full_template_resolves_with_zero_errors', () => {
  const text = renderBootstrapTemplate({ template: 'full', lanes: 2, generatedOn: '2026-10-17' })
  assert.equal(typeof text, 'string')

  const resolved = resolveFlow(text, { allowedModels: ALLOWED })
  assert.deepEqual(resolved.problems, [], 'a generated file must resolve without a single problem')
  assert.equal(resolved.ok, true)
  assert.equal(resolved.entry, 'design')
  assert.deepEqual(resolved.joins, [{ at: 'cr', lanes: ['implement-a', 'implement-b'] }])
  assert.deepEqual(resolved.stages.map(stage => stage.id),
    ['design', 'contract-tests', 'implement-a', 'implement-b', 'cr', 'commit'])

  for (const stage of resolved.stages) {
    assert.equal(stage.route, null, `${stage.id} is not routed yet`)
    assert.equal(stage.routeSource, 'session')
    assert.equal(stage.fallback, true)
    assert.ok(typeof stage.instruction === 'string' && stage.instruction.length > 0, `${stage.id} needs a brief`)
  }
  assert.match(text, /首次清单/)
  assert.match(text, /2026-10-17/)
  assert.ok(!/^laneDir:/m.test(text), 'no laneDir unless the layout asks for one')
})

test('bootstrap_minimal_template_valid', () => {
  const text = renderBootstrapTemplate({ template: 'minimal', lanes: 2 })
  assert.match(text, /%% entry: plan/)

  const resolved = resolveFlow(text, { allowedModels: ALLOWED })
  assert.deepEqual(resolved.problems, [])
  assert.equal(resolved.entry, 'plan')
  assert.deepEqual(resolved.stages.map(stage => stage.id),
    ['plan', 'contract-tests', 'implement-a', 'implement-b', 'cr', 'commit'])
  assert.deepEqual(resolved.loops.map(loop => `${loop.kind} ${loop.via}->${loop.backTo} ${loop.maxRounds ?? loop.maxRepeats}`),
    ['review verdict->race 2'], 'minimal keeps one review loop and no other back edge')
})

test('bootstrap_entry_and_labeled_back_edges', () => {
  for (const [preset, entry] of [['full', 'design'], ['minimal', 'plan']]) {
    const text = renderBootstrapTemplate({ template: preset, lanes: 2 })
    assert.ok(text.includes(`%% entry: ${entry}`), `${preset} declares its entry`)

    const resolved = resolveFlow(text, {})
    assert.deepEqual(codes(resolved, 'error'), [])
    assert.equal(resolved.entry, entry)
    assert.ok(resolved.loops.length > 0, `${preset} has a back edge`)
    for (const loop of resolved.loops) {
      const node = resolved.nodes.find(item => item.id === loop.via)
      const edge = node.next.find(item => item.to === loop.backTo)
      assert.ok(edge && typeof edge.when === 'string' && edge.when.length > 0,
        `${loop.via}->${loop.backTo} must carry a condition, never a bare back edge`)
    }
  }

  const full = resolveFlow(renderBootstrapTemplate({ template: 'full', lanes: 2 }), {})
  assert.deepEqual(full.loops.map(loop => `${loop.kind} ${loop.via}->${loop.backTo}`).sort(),
    ['review confirm->race', 'stage confirm->design', 'stage final->design', 'stage gate->design'])
})

test('bootstrap_full_template_carries_the_confirm_user_gate', () => {
  const resolved = resolveFlow(renderBootstrapTemplate({ template: 'full', lanes: 2 }), {})
  assert.deepEqual(codes(resolved, 'error'), [])

  const confirm = resolved.nodes.find(item => item.id === 'confirm')
  assert.ok(confirm, 'the full preset has the confirm user gate (parity with doc/racing-code.md)')
  assert.equal(confirm.kind, 'user_gate')
  assert.deepEqual(confirm.next.map(edge => edge.to).sort(), ['commit', 'design', 'race'])
  assert.deepEqual(confirm.next.map(edge => edge.when).sort(), ['先完善约束', '发回修订', '接受现状'])

  const verdict = resolved.nodes.find(item => item.id === 'verdict')
  assert.deepEqual(verdict.next.map(edge => edge.to).sort(), ['commit', 'confirm'],
    'the review loop goes back through the user gate, never straight to race')
  assert.ok(!resolved.stages.some(stage => stage.id === 'confirm'), 'a user gate is not a stage')
})

test('bootstrap_preview_renders_all_stages_as_session', () => {
  for (const lanes of [2, 3, 4]) {
    const text = renderBootstrapTemplate({ template: 'full', lanes, models: {} })
    const resolved = resolveFlow(text, { allowedModels: ALLOWED })
    assert.deepEqual(resolved.problems, [])
    assert.equal(resolved.joins.length, 1, 'one race group')
    assert.equal(resolved.joins[0].lanes.length, lanes)

    for (const stage of resolved.stages) {
      assert.equal(stage.routeSource, 'session', `${stage.id} previews as session`)
      assert.equal(stage.route, null)
      assert.match(text, new RegExp(`^\\s*${stage.id}: session\\s*(#.*)?$`, 'm'),
        `${stage.id} must have its own "session" entry`)
    }
    for (const id of resolved.joins[0].lanes) {
      assert.equal(byId(resolved, id).lane.worktree, `.worktrees/${id}`, 'no laneDir means the default layout')
    }
  }
})

// ─────────────────────────────── gate 2: the tabs ───────────────────────────────

test('bootstrap_nodes_in_flow_order_with_required_lanes', () => {
  const { nodes, notes } = buildRouteChoices({ allowedModels: ALLOWED, catalog: CATALOG, stages: STAGES, lanes: LANES })
  assert.deepEqual(nodes.map(node => node.id), STAGES.map(stage => stage.id), 'flow order, entry first')
  assert.deepEqual(nodes.map(node => node.kind), ['stage', 'stage', 'lane', 'lane', 'stage', 'stage'])
  assert.deepEqual(nodes.map(node => node.required), [false, false, true, true, false, false],
    'only lane stages must be chosen')
  assert.ok(nodes.every(node => node.default === 'session'))
  assert.equal(nodes[0].label, '设计')
  assert.equal(nodes[0].brief, '产出设计文档，不写代码')
  assert.equal(nodes[1].brief, '')
  assert.ok(nodes.every(node => Array.isArray(node.candidates)))

  const text = notes.join('\n')
  assert.match(text, /cr/, 'the CR question must name the reviewer')
  assert.match(text, /自评|偏好/, 'the CR question must warn about reviewing a lane it shares a model with')
})

test('bootstrap_candidates_intersect_allowlist_and_catalog', () => {
  const { nodes } = buildRouteChoices({ allowedModels: ALLOWED, catalog: CATALOG, stages: STAGES, lanes: LANES })
  const expected = ['kilo/kilo-auto/free', 'opencode-go/deepseek-v4.1-flash']
  for (const node of nodes) {
    assert.deepEqual(node.candidates.map(key).sort(), expected, `${node.id} offers allowlist ∩ catalog`)
    assert.ok(node.candidates.every(candidate => candidate.authorized === true))
  }
  assert.equal(nodes[0].candidates.find(candidate => candidate.model === 'deepseek-v4.1-flash').note, '与 contract-tests 同款')

  // The allowlist service being unavailable skips the check instead of hiding every route.
  const open = buildRouteChoices({ allowedModels: null, catalog: CATALOG, stages: STAGES, lanes: LANES })
  assert.deepEqual(open.nodes[0].candidates.map(key).sort(),
    ['kilo/kilo-auto/free', 'opencode-go/deepseek-v4.1-flash', 'opencode-go/glm-5.3-flash', 'other-vendor/x-large'])
  assert.ok(open.nodes[0].candidates.every(candidate => candidate.authorized === true))
})

test('bootstrap_no_candidates_keeps_session_option', () => {
  const { nodes, notes } = buildRouteChoices({ allowedModels: [], catalog: CATALOG, stages: STAGES, lanes: LANES })
  assert.ok(nodes.length > 0)
  for (const node of nodes) {
    assert.deepEqual(node.candidates, [], 'a known-empty allowlist leaves no candidate')
    assert.equal(node.default, 'session', 'the session option always stays')
    assert.equal(node.required, node.kind === 'lane')
  }
  assert.ok(notes.some(note => note.includes('BOOTSTRAP_NO_CANDIDATES')), notes.join(' | '))
})

// ─────────────────────────────── the pre-flight plan ───────────────────────────────

test('bootstrap_plan_git_container_heuristic', () => {
  const container = buildPlan(facts())
  assertPlanShape(container)
  const text = planText(container)
  assert.ok(container.every(item => item.status !== 'blocked'), 'a worktree container is ready to bootstrap')
  assert.match(text, /worktree add/, 'the container gets the "open the lanes" command')
  assert.match(text, /racing\/implement-a/, 'lane dirs are branch names here')
  assert.ok(!/\.gitignore/.test(text), 'branch lane dirs need no ignore entry')

  const unknown = buildPlan(facts({ gitLayout: 'unknown', laneDir: undefined }))
  assertPlanShape(unknown)
  assert.ok(unknown.some(item => item.status === 'warn' && /gitdir/i.test(`${item.detail} ${item.fix ?? ''}`)),
    'a gitdir: that points nowhere is reported, not silently treated as a repo')
})

test('bootstrap_plan_gitignore_only_for_default_lane_dir', () => {
  const repo = { gitLayout: 'git-repo', laneDir: undefined, gitignore: null }
  const missing = buildPlan(facts(repo))
  assertPlanShape(missing)
  const warned = missing.filter(item => /\.gitignore/.test(`${item.detail} ${item.fix ?? ''}`))
  assert.ok(warned.length > 0, 'a plain git repo must be told to ignore the default lane dir')
  assert.ok(warned.some(item => item.status === 'warn' && /\.worktrees\/?/.test(`${item.detail} ${item.fix ?? ''}`)))

  const covered = buildPlan(facts({ ...repo, gitignore: 'node_modules/\n.worktrees/\n' }))
  assertPlanShape(covered)
  assert.ok(!covered.some(item => item.status === 'warn' && /\.gitignore/.test(`${item.detail} ${item.fix ?? ''}`)),
    'an existing ignore entry is not a warning')

  const branch = buildPlan(facts({ gitLayout: 'worktree-container', laneDir: 'branch', gitignore: null }))
  assertPlanShape(branch)
  assert.ok(!branch.some(item => /\.gitignore/.test(`${item.detail} ${item.fix ?? ''}`)),
    'the branch layout never asks for a .gitignore')
})

test('bootstrap_plan_no_git_is_blocked', () => {
  const plan = buildPlan(facts({ gitLayout: 'none', laneDir: undefined, gitignore: null }))
  assertPlanShape(plan)
  const blocked = plan.filter(item => item.status === 'blocked')
  assert.ok(blocked.length > 0, 'parallel lanes cannot start outside a repository')
  assert.match(planText(blocked), /git init/)
})

// ─────────────────────────────── the write target ───────────────────────────────

test('bootstrap_target_outside_root_rejected', () => {
  assert.deepEqual(checkBootstrapTarget({ cwd: '/projects/demo', projectFlowPath: 'doc/racing-code.md' }),
    { ok: true, file: '/projects/demo/doc/racing-code.md' })
  assert.equal(checkBootstrapTarget({ cwd: '/projects/demo', projectFlowPath: '' }).file,
    '/projects/demo/doc/racing-code.md', 'an empty path means the default')

  const inside = checkBootstrapTarget({ cwd: '/projects/demo', projectFlowPath: '/projects/demo/doc/flow.md' })
  assert.equal(inside.ok, true)
  assert.equal(inside.file, '/projects/demo/doc/flow.md')

  for (const escaped of ['../outside.md', 'doc/../../evil.md', '/etc/racing-code.md']) {
    const result = checkBootstrapTarget({ cwd: '/projects/demo', projectFlowPath: escaped })
    assert.equal(result.ok, false, `${escaped} must be rejected`)
    assert.equal(result.code, 'BOOTSTRAP_TARGET_OUTSIDE_ROOT')
    assert.ok(typeof result.message === 'string' && result.message.length > 0)
  }
  assert.equal(checkBootstrapTarget({ cwd: '', projectFlowPath: 'doc/racing-code.md' }).ok, false,
    'a cwd that cannot anchor containment is rejected')
})

test('bootstrap_zero_error_guard_blocks_bad_spec', () => {
  for (const spec of [
    { template: 'nope' },
    { template: 'full', lanes: 9 },
    { template: 'full', models: { cr: 'not a route' } },
  ]) {
    assert.throws(() => renderBootstrapTemplate({ lanes: 2, ...spec }), /BOOTSTRAP_TEMPLATE_INVALID/, JSON.stringify(spec))
  }
  const resolved = resolveFlow(renderBootstrapTemplate({ template: 'full', lanes: 2 }), { allowedModels: ALLOWED })
  assert.deepEqual(codes(resolved, 'error'), [], 'the guard is active: a rendered file never has an error')
})

// ─────────────────────────────── the two-gate protocol ───────────────────────────────

test('bootstrap_protocol_has_two_gates', () => {
  const file = '/projects/demo/doc/racing-code.md'
  const protocol = bootstrapProtocol({ file, lanes: 3 })
  assert.ok(Array.isArray(protocol) && protocol.length >= 9, 'the nine steps of doc/bootstrap.md §2')
  assert.ok(protocol.every(step => typeof step === 'string' && step.trim().length > 0))

  const text = protocol.join('\n')
  assert.ok(text.includes(file), 'the protocol spells out the target file')
  assert.match(text, /racing_code_init/)
  assert.match(text, /write\s*:\s*false/, 'the first call only previews')
  assert.match(text, /write\s*:\s*true/, 'the write comes after both gates')
  assert.match(text, /预览|preview/i)
  assert.match(text, /新开会话/)

  const at = pattern => {
    const index = text.search(pattern)
    assert.ok(index >= 0, `protocol is missing ${pattern}`)
    return index
  }
  assert.ok(at(/介入\s*1/) < at(/介入\s*2/), 'gate 1 comes before gate 2')
  assert.ok(at(/介入\s*2/) < at(/write\s*:\s*true/), 'the write comes after gate 2')
  assert.ok(at(/新开会话/) > at(/write\s*:\s*true/), 'the restart notice belongs to the write step')

  assert.notEqual(bootstrapProtocol({ file, lanes: 3 }).join('\n'), bootstrapProtocol({ file, lanes: 2 }).join('\n'),
    'the protocol must use the lane count it was given')
})

test('template_briefs_state_the_route_split_and_the_gate_protocol', () => {
  const text = renderBootstrapTemplate({ template: 'full', lanes: 2 })
  const brief = id => text.split('### ' + id)[1].split('### ')[0]
  assert.match(brief('design'), /声明/)
  assert.match(brief('design'), /在当前会话直接执行/)
  assert.match(brief('contract-tests'), /在当前会话直接执行/)
  assert.match(brief('cr'), /建议/)
  assert.match(brief('cr'), /完整材料/)
  assert.match(brief('commit'), /声明/)
  assert.match(brief('commit'), /合入当前工作分支/)
  assert.match(text, /lane 永远委派/)
  assert.doesNotMatch(text, /commit 阶段永远委派/, 'the template must not promise a stage-name exception')
})
