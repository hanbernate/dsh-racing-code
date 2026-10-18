// Contract tests for lib/flow.js. Written against the interface and the grammar in
// doc/workflow-format.md — they must not be adjusted to fit an implementation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  attachInstructions, buildFlow, buildLanes, buildLoops, checkAuthorized, checkLabelShadowing,
  checkReviewer, classifyBackEdges, classifyEdges, diagnose, laneAgentName, laneAgentNameLine,
  mergeRoutes, parseFrontMatter,
  parseMermaid, parseNodeLabel, parseYamlSubset, renderMermaid, renderPolicySection, resolveEntry,
  resolveFlow, summarize,
} from '../lib/flow.js'

const FENCE = '```mermaid'

/** Build a flow document without fighting template-literal fences. */
function doc(frontMatter, mermaidLines, body = '') {
  return [
    ...(frontMatter === null ? [] : ['---', ...frontMatter, '---']),
    '',
    '# Flow',
    '',
    FENCE,
    ...mermaidLines,
    '```',
    ...(body ? ['', body] : []),
    '',
  ].join('\n')
}

const REAL = readFileSync(new URL('../doc/racing-code.md', import.meta.url), 'utf8')

const LINEAR = ['flowchart TD', '  a["A"] --> b["B"]', '  b --> c["C"]']
const LANES = [
  'flowchart TD',
  '  %% entry: start',
  '  start["Start"] --> race{{"Race"}}',
  '  race --> lane-a["Lane A"]',
  '  race --> lane-b["Lane B"]',
  '  lane-a --> cr["CR"]',
  '  lane-b --> cr',
  '  cr --> done["Done"]',
]
const ROUNDS = [
  'flowchart TD',
  '  %% entry: start',
  '  start["Start"] --> race{{"Race"}}',
  '  race --> lane-a["Lane A"]',
  '  race --> lane-b["Lane B"]',
  '  lane-a --> cr["CR"]',
  '  lane-b --> cr',
  '  cr --> verdict{"All passing?"}',
  '  verdict -- "no" --> race',
  '  verdict -- "yes" --> done["Done"]',
]

const codes = problems => problems.map(p => p.code)
const has = (problems, code) => codes(problems).includes(code)
const only = problems => assert.deepEqual([...new Set(codes(problems))], codes(problems), 'duplicate codes')
const byId = (resolved, id) => resolved.stages.find(s => s.id === id)
const nodeById = (resolved, id) => resolved.nodes.find(n => n.id === id)

// ─────────────────────────────── YAML subset + front matter ───────────────────────────────

test('parseYamlSubset: scalars, nesting, comments, typing', () => {
  const { data, problems } = parseYamlSubset([
    '# leading comment',
    'version: 1            # trailing comment',
    'flag: true',
    'ratio: 0.5',
    'name: "quoted value"',
    'nested:',
    '  provider: opencode-go',
    '  model: mimo-v2.6-pro',
    '',
  ].join('\n'))
  assert.deepEqual(problems, [])
  assert.deepEqual(data, {
    version: 1,
    flag: true,
    ratio: 0.5,
    name: 'quoted value',
    nested: { provider: 'opencode-go', model: 'mimo-v2.6-pro' },
  })
})

test('parseYamlSubset: arrays, flow style and multi-line strings are refused, not guessed', () => {
  for (const bad of ['list:\n  - one', 'flow: {a: 1}', 'flow: [1, 2]', 'block: |', 'fold: >']) {
    const { problems } = parseYamlSubset(bad)
    assert.ok(has(problems, 'FLOW_YAML_UNSUPPORTED'), `expected refusal for ${JSON.stringify(bad)}`)
  }
})

test('parseFrontMatter: missing block is normal, present block is stripped from the body', () => {
  const absent = parseFrontMatter('# just a file\n\nbody text\n')
  assert.deepEqual(absent.data, {})
  assert.ok(has(absent.problems, 'FLOW_NO_FRONT_MATTER'))
  assert.match(absent.body, /body text/)

  const present = parseFrontMatter('---\nracing-code: 1\nmodels:\n  cr: kilo/kilo-auto/free\n---\n\n# B\n')
  assert.equal(present.data['racing-code'], 1)
  assert.deepEqual(present.data.models, { cr: 'kilo/kilo-auto/free' })
  assert.ok(!present.body.includes('racing-code: 1'))
  assert.match(present.body, /# B/)
})

// ─────────────────────────────── node labels ───────────────────────────────

test('parseNodeLabel: second line becomes a route in either separator form', () => {
  assert.deepEqual(parseNodeLabel('Implement A<br/>opencode-go · deepseek-v4.1-flash'), {
    label: 'Implement A',
    route: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  })
  assert.deepEqual(parseNodeLabel('Implement B<br/>kilo/kilo-auto/free'), {
    label: 'Implement B',
    route: { provider: 'kilo', model: 'kilo-auto/free' },
  })
  assert.deepEqual(parseNodeLabel('设计 · 第一阶段'), { label: '设计 · 第一阶段', route: null })
  assert.deepEqual(parseNodeLabel('实现 A<br/>kilo · kilo-auto/free · high').route, null)
  assert.deepEqual(parseNodeLabel('Lane A'), { label: 'Lane A', route: null })
})

// ─────────────────────────────── mermaid subset ───────────────────────────────

test('parseMermaid: four node shapes and the deprecated round form', () => {
  const { nodes, problems } = parseMermaid(doc(null, [
    'flowchart TD',
    '  a["Stage"] --> g{{"Group"}}',
    '  g --> d{"Decision"}',
    '  d -- "x" --> u(["Gate"])',
    '  u -- "y" --> r(Round)',
  ]))
  assert.deepEqual(nodes.map(n => [n.id, n.kind]), [
    ['a', 'stage'], ['g', 'group'], ['d', 'decision'], ['u', 'user_gate'], ['r', 'stage'],
  ])
  assert.ok(has(problems, 'FLOW_ROUND_NODE_DEPRECATED'))
})

test('parseMermaid: edges, chains, both condition forms and the ignore list', () => {
  const { edges, problems } = parseMermaid(doc(null, [
    'flowchart LR',
    '  %% a comment',
    '  subgraph one',
    '    direction TD',
    '    a["A"] --> b["B"] --> c["C"]',
    '    b -- "why" --> d["D"]',
    '    d -->|how| e["E"]',
    '    e -.-> f["F"]',
    '    f ==> g["G"]',
    '  end',
    '  classDef big fill:#fff',
    '  class a big',
    '  style b stroke:#000',
    '  linkStyle 0 stroke:#000',
    '  click c "https://example.test"',
    '  %% entry: a',
  ]))
  assert.deepEqual(problems, [])
  assert.deepEqual(edges.map(e => [e.from, e.to, e.when]), [
    ['a', 'b', null], ['b', 'c', null], ['b', 'd', 'why'], ['d', 'e', 'how'],
    ['e', 'f', null], ['f', 'g', null],
  ])
})

test('parseMermaid: entry directive, missing fence, multiple fences, wrong diagram type', () => {
  assert.equal(parseMermaid(doc(null, ['flowchart TD', '  %% entry: a', '  a["A"]'])).entry, 'a')
  assert.ok(has(parseMermaid('# no diagram here\n').problems, 'FLOW_FENCE_MISSING'))
  assert.ok(has(parseMermaid([FENCE, 'flowchart TD', '  a["A"]', '```', FENCE, 'flowchart TD', '  b["B"]', '```'].join('\n')).problems,
    'FLOW_MULTIPLE_FENCES'))
  assert.ok(has(parseMermaid(doc(null, ['sequenceDiagram', '  a ->> b: hi'])).problems, 'FLOW_UNSUPPORTED_DIAGRAM'))
})

test('parseMermaid: bad ids, duplicate declarations and unparsable edges', () => {
  assert.ok(has(parseMermaid(doc(null, ['flowchart TD', '  A["x"] --> B["y"]'])).problems, 'FLOW_BAD_NODE_ID'))
  assert.ok(has(parseMermaid(doc(null, ['flowchart TD', '  a["one"] --> b["B"]', '  a["two"] --> c["C"]'])).problems,
    'FLOW_DUPLICATE_NODE'))
  assert.ok(!has(parseMermaid(doc(null, ['flowchart TD', '  a["one"] --> b["B"]', '  a --> c["C"]'])).problems,
    'FLOW_DUPLICATE_NODE'))
  assert.ok(has(parseMermaid(doc(null, ['flowchart TD', '  a["A"] & b["B"] --> c["C"]'])).problems, 'FLOW_UNPARSABLE_EDGE'))
})

test('parseMermaid: junk after a node closure is an error, not a silent label', () => {
  const { problems } = parseMermaid(doc(null, ['flowchart TD', '  a["A"] junk --> c["C"]']))
  assert.ok(has(problems, 'FLOW_UNPARSABLE_NODE'))
  assert.deepEqual(parseMermaid(doc(null, ['flowchart TD', '  a["A"] --> c["C"]'])).problems, [])
})

// ─────────────────────────────── entry ───────────────────────────────

test('resolveEntry: a linear flow needs no directive', () => {
  const parsed = parseMermaid(doc(null, LINEAR))
  const { entry, problems } = resolveEntry(parsed.nodes, parsed.edges, null)
  assert.equal(entry, 'a')
  assert.deepEqual(problems, [])
})

test('resolveEntry: a simple loop still has exactly one legal entry', () => {
  const parsed = parseMermaid(doc(null, [
    'flowchart TD', '  a["A"] --> b["B"]',
    '  b -- "again" --> a',
  ]))
  const { entry, problems } = resolveEntry(parsed.nodes, parsed.edges, null)
  assert.equal(entry, 'a')
  assert.deepEqual(problems, [])
})

test('resolveEntry: several legal entries need the directive, and naming one resolves it', () => {
  const parsed = parseMermaid(doc(null, [
    'flowchart TD',
    '  a["A"] --> b(["B?"])',
    '  b -- "no" --> a',
    '  b -- "yes" --> c["C"]',
    '  c -- "again" --> a',
  ]))
  const ambiguous = resolveEntry(parsed.nodes, parsed.edges, null)
  assert.equal(ambiguous.entry, null)
  assert.ok(has(ambiguous.problems, 'FLOW_AMBIGUOUS_ENTRY'))
  assert.ok(ambiguous.candidates.length > 1)

  // 'b' is not a legal entry (from it, a --> b would be an unconditional back edge);
  // the directive must name one of the legal candidates.
  assert.equal(resolveEntry(parsed.nodes, parsed.edges, 'b').problems[0].code, 'FLOW_BAD_ENTRY')
  const declared = resolveEntry(parsed.nodes, parsed.edges, 'c')
  assert.equal(declared.entry, 'c')
  assert.deepEqual(declared.problems, [])
})

test('resolveEntry: unknown directive target and a node that cannot be an entry', () => {
  const parsed = parseMermaid(doc(null, LINEAR))
  assert.ok(has(resolveEntry(parsed.nodes, parsed.edges, 'nope').problems, 'FLOW_BAD_ENTRY'))
  const sink = resolveEntry(parsed.nodes, parsed.edges, 'c')
  assert.equal(sink.entry, 'c')
  assert.ok(has(sink.problems, 'FLOW_BAD_ENTRY'))
})

test('resolveEntry: disconnected roots have no legal entry', () => {
  const parsed = parseMermaid(doc(null, ['flowchart TD', '  a["A"]', '  b["B"]']))
  const { entry, problems } = resolveEntry(parsed.nodes, parsed.edges, null)
  assert.equal(entry, null)
  assert.ok(has(problems, 'FLOW_NO_ENTRY'))
})

// ─────────────────────────────── edge semantics ───────────────────────────────

test('classifyEdges: stages sequence or branch, and are refused a bare fan-out', () => {
  const ok = parseMermaid(doc(null, ['flowchart TD', '  a["A"] --> b["B"]', '  a -- "x" --> c["C"]']))
  assert.deepEqual(classifyEdges(ok.nodes, ok.edges).problems, [])

  const fanout = parseMermaid(doc(null, ['flowchart TD', '  a["A"] --> b["B"]', '  a --> c["C"]']))
  assert.ok(has(classifyEdges(fanout.nodes, fanout.edges).problems, 'FLOW_STAGE_FANOUT_NOT_GROUP'))

  const mixed = parseMermaid(doc(null, ['flowchart TD', '  a["A"] --> b["B"]', '  a --> c["C"]', '  a -- "z" --> d["D"]']))
  assert.ok(has(classifyEdges(mixed.nodes, mixed.edges).problems, 'FLOW_AMBIGUOUS_FANOUT'))
})

test('classifyEdges: groups fan out, decisions and gates must label their options', () => {
  const group = parseMermaid(doc(null, ['flowchart TD', '  g{{"G"}} --> a["A"]', '  g --> b["B"]']))
  assert.deepEqual(classifyEdges(group.nodes, group.edges).problems, [])
  const lone = parseMermaid(doc(null, ['flowchart TD', '  g{{"G"}} --> a["A"]']))
  assert.ok(has(classifyEdges(lone.nodes, lone.edges).problems, 'FLOW_GROUP_NEEDS_TWO_LANES'))
  const labeled = parseMermaid(doc(null, ['flowchart TD', '  g{{"G"}} --> a["A"]', '  g -- "x" --> b["B"]']))
  assert.ok(has(classifyEdges(labeled.nodes, labeled.edges).problems, 'FLOW_GROUP_LABELED_EDGE'))

  const deadEnd = parseMermaid(doc(null, ['flowchart TD', '  a["A"] --> d{"D"}']))
  assert.ok(has(classifyEdges(deadEnd.nodes, deadEnd.edges).problems, 'FLOW_DECISION_DEAD_END'))

  const unlabeledGate = parseMermaid(doc(null, ['flowchart TD', '  u(["U"]) --> a["A"]', '  u -- "x" --> b["B"]']))
  assert.ok(has(classifyEdges(unlabeledGate.nodes, unlabeledGate.edges).problems, 'FLOW_DECISION_UNLABELED_EDGE'))

  const defaultedDecision = parseMermaid(doc(null, ['flowchart TD', '  d{"D"} -- "x" --> a["A"]', '  d --> b["B"]']))
  assert.deepEqual(classifyEdges(defaultedDecision.nodes, defaultedDecision.edges).problems, [])
})

test('classifyBackEdges: conditional back edges pass, unconditional ones and stray cycles do not', () => {
  const good = parseMermaid(doc(null, ROUNDS))
  const back = classifyBackEdges(good.nodes, good.edges, 'start')
  assert.deepEqual(back.problems, [])
  assert.deepEqual(back.back.map(e => [e.from, e.to]), [['verdict', 'race']])

  const bad = parseMermaid(doc(null, ['flowchart TD', '  a["A"] --> b["B"]', '  b --> a']))
  assert.ok(has(classifyBackEdges(bad.nodes, bad.edges, 'a').problems, 'FLOW_UNLABELED_BACK_EDGE'))
})

// ─────────────────────────────── lanes and join ───────────────────────────────

test('buildLanes: one lane per successor, join is the earliest common node', () => {
  const parsed = parseMermaid(doc(null, LANES))
  const group = parsed.nodes.find(n => n.kind === 'group')
  const { lanes, join, problems } = buildLanes(parsed.nodes, parsed.edges, group, { maxLanes: 4 })
  assert.deepEqual(problems, [])
  assert.equal(join, 'cr')
  assert.deepEqual(lanes.map(l => l.id), ['lane-a', 'lane-b'])
  assert.deepEqual(lanes[0].path, ['lane-a'])
  assert.deepEqual(lanes[0], { id: 'lane-a', path: ['lane-a'], fanOutFrom: 'race', joinAt: 'cr' })
})

test('buildLanes: a lane may chain stages and shares one worktree', () => {
  const parsed = parseMermaid(doc(null, [
    'flowchart TD', '  %% entry: start',
    '  start["S"] --> race{{"R"}}',
    '  race --> a1["A1"] --> a2["A2"] --> cr["CR"]',
    '  race --> b1["B1"] --> cr',
  ]))
  const group = parsed.nodes.find(n => n.kind === 'group')
  const { lanes, problems } = buildLanes(parsed.nodes, parsed.edges, group, { maxLanes: 4 })
  assert.deepEqual(problems, [])
  assert.deepEqual(lanes.map(l => [l.id, l.path]), [['a1', ['a1', 'a2']], ['b1', ['b1']]])
})

test('buildLanes: no join, nested group, branching inside a lane, too many lanes', () => {
  const noJoin = parseMermaid(doc(null, ['flowchart TD', '  g{{"G"}} --> a["A"]', '  g --> b["B"]']))
  assert.ok(has(buildLanes(noJoin.nodes, noJoin.edges, noJoin.nodes[0], { maxLanes: 4 }).problems, 'FLOW_NO_JOIN'))

  const nested = parseMermaid(doc(null, [
    'flowchart TD', '  g{{"G"}} --> inner{{"I"}}', '  g --> b["B"]',
    '  inner --> a["A"]', '  inner --> a2["A2"]', '  a --> j["J"]', '  a2 --> j', '  b --> j',
  ]))
  assert.ok(has(buildLanes(nested.nodes, nested.edges, nested.nodes[0], { maxLanes: 4 }).problems, 'FLOW_NESTED_FANOUT'))

  const branchy = parseMermaid(doc(null, [
    'flowchart TD', '  g{{"G"}} --> a["A"]', '  g --> b["B"]',
    '  a -- "x" --> j["J"]', '  a -- "y" --> k["K"]', '  b --> j', '  k --> j',
  ]))
  assert.ok(has(buildLanes(branchy.nodes, branchy.edges, branchy.nodes[0], { maxLanes: 4 }).problems, 'FLOW_BRANCH_INSIDE_LANE'))

  const many = parseMermaid(doc(null, ['flowchart TD', '  g{{"G"}} --> a["A"]', '  g --> b["B"]', '  g --> c["C"]']))
  assert.ok(has(buildLanes(many.nodes, many.edges, many.nodes[0], { maxLanes: 2 }).problems, 'FLOW_TOO_MANY_LANES'))
})

test('laneDir: default .worktrees, `branch` mirrors the branch name, other values are parent dirs', () => {
  const flow = extra => ['flowchart TD', '  %% entry: s', '  s["S"] --> g{{"G"}}', '  g --> a["A"]', '  g --> b["B"]',
    '  a --> j["J"]', '  b --> j', ...extra]
  const lanesOf = text => {
    const resolved = resolveFlow(text, {})
    const stage = resolved.stages.find(item => item.id === 'a')
    return {
      worktree: stage.lane.worktree,
      branch: stage.lane.branch,
      codes: resolved.problems.map(item => item.code),
    }
  }
  assert.equal(lanesOf(doc(null, flow([]))).worktree, '.worktrees/a')
  const branchMode = lanesOf(doc(['racing-code: 1', 'laneDir: branch'], flow([])))
  assert.deepEqual([branchMode.worktree, branchMode.branch], ['racing/a', 'racing/a'])
  assert.ok(!branchMode.codes.includes('FLOW_LANE_DIR_INVALID'))
  assert.equal(lanesOf(doc(['racing-code: 1', 'laneDir: wt'], flow([]))).worktree, 'wt/a')

  for (const bad of ['../evil', '/abs/path', '', 'a/b']) {
    const result = lanesOf(doc(['racing-code: 1', `laneDir: "${bad}"`], flow([])))
    assert.equal(result.worktree, '.worktrees/a', `laneDir ${JSON.stringify(bad)} must fall back`)
    assert.ok(result.codes.includes('FLOW_LANE_DIR_INVALID'), `laneDir ${JSON.stringify(bad)} must warn`)
  }
})

// ─────────────────────────────── loops ───────────────────────────────

test('buildLoops: a back edge into a group is a review round with the configured cap', () => {
  const parsed = parseMermaid(doc(null, ROUNDS))
  const { back } = classifyBackEdges(parsed.nodes, parsed.edges, 'start')
  const { loops, problems } = buildLoops(parsed.nodes, parsed.edges, back, { maxStageRepeats: 3, maxReviewRounds: 2 })
  assert.deepEqual(problems, [])
  assert.deepEqual(loops, [{
    kind: 'review', via: 'verdict', backTo: 'race', condition: 'no', maxRounds: 2,
  }])
})

test('buildLoops: a back edge into a stage is a repeat, and a re-raced group without a review warns', () => {
  const stageLoop = parseMermaid(doc(null, ['flowchart TD', '  a["A"] --> b["B"]', '  b -- "again" --> a']))
  const back = classifyBackEdges(stageLoop.nodes, stageLoop.edges, 'a').back
  const { loops } = buildLoops(stageLoop.nodes, stageLoop.edges, back, { maxStageRepeats: 3, maxReviewRounds: 2 })
  assert.deepEqual(loops, [{ kind: 'stage', via: 'b', backTo: 'a', condition: 'again', maxRepeats: 3 }])

  const unreviewed = parseMermaid(doc(null, [
    'flowchart TD', '  %% entry: start',
    '  start["S"] --> race{{"R"}}',
    '  race --> a["A"]', '  race --> b["B"]',
    '  a --> verdict{"ok?"}', '  b --> verdict',
    '  verdict -- "no" --> race', '  verdict -- "yes" --> done["Done"]',
  ]))
  const back2 = classifyBackEdges(unreviewed.nodes, unreviewed.edges, 'start').back
  const built = buildLoops(unreviewed.nodes, unreviewed.edges, back2, { maxStageRepeats: 3, maxReviewRounds: 2 })
  assert.ok(has(built.problems, 'FLOW_LOOP_WITHOUT_REVIEW'))
})

// ─────────────────────────────── buildFlow ───────────────────────────────

test('buildFlow: assembles nodes, stages, joins and loops', () => {
  const parsed = parseMermaid(doc(null, ROUNDS))
  const resolved = buildFlow(parsed, { maxReviewRounds: 2 })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.entry, 'start')
  assert.deepEqual(resolved.joins, [{ at: 'cr', lanes: ['lane-a', 'lane-b'] }])
  assert.equal(resolved.loops.length, 1)
  assert.deepEqual(resolved.stages.map(s => s.id), ['start', 'lane-a', 'lane-b', 'cr', 'done'])
  assert.deepEqual(nodeById(resolved, 'race').kind, 'group')
  byId(resolved, 'lane-a').lane && assert.equal(byId(resolved, 'lane-a').lane.worktree, '.worktrees/lane-a')
  assert.deepEqual(byId(resolved, 'start').next, [{ when: null, to: 'race' }])
  assert.deepEqual(byId(resolved, 'cr').next, [{ when: null, to: 'verdict' }])
  assert.deepEqual(nodeById(resolved, 'verdict').next, [{ when: 'no', to: 'race' }, { when: 'yes', to: 'done' }])
})

test('buildFlow: an unreachable stage is an error', () => {
  const parsed = parseMermaid(doc(null, ['flowchart TD', '  %% entry: a', '  a["A"] --> b["B"]', '  z["Z"] --> b']))
  const resolved = buildFlow(parsed, {})
  assert.equal(resolved.ok, false)
  assert.ok(has(resolved.problems, 'FLOW_UNREACHABLE_STAGE'))
})

test('buildFlow: a broken flow reports errors instead of throwing, and never hides the reason', () => {
  const resolved = resolveFlow(doc(['racing-code: 1'], ['flowchart TD', '  a["A"] -->']))
  assert.equal(resolved.ok, false)
  assert.ok(resolved.problems.some(p => p.level === 'error'))
})

// ─────────────────────────────── routes ───────────────────────────────

test('mergeRoutes: label beats front matter, front matter beats the session route', () => {
  const parsed = parseMermaid(doc(null, [
    'flowchart TD', '  a["A<br/>kilo/kilo-auto/free"] --> b["B"]',
  ]))
  const resolved = buildFlow(parsed, {})
  const merged = mergeRoutes(resolved.stages, { a: 'opencode-go/mimo-v2.6-pro', b: 'opencode-go/glm-5.3-flash' }, null)
  assert.deepEqual(byId({ stages: merged.stages }, 'a').route, { provider: 'kilo', model: 'kilo-auto/free' })
  assert.equal(byId({ stages: merged.stages }, 'a').routeSource, 'label')
  assert.deepEqual(byId({ stages: merged.stages }, 'b').route, { provider: 'opencode-go', model: 'glm-5.3-flash' })
  assert.equal(byId({ stages: merged.stages }, 'b').routeSource, 'front-matter')

  const fallback = mergeRoutes(resolved.stages, {},
    { provider: 'kilo', model: 'kilo-auto/free' })
  assert.equal(byId({ stages: fallback.stages }, 'a').fallback, false)
  assert.equal(byId({ stages: fallback.stages }, 'a').routeSource, 'label')

  const nothing = mergeRoutes(resolved.stages, {}, null)
  assert.equal(byId({ stages: nothing.stages }, 'b').fallback, true)
  assert.equal(byId({ stages: nothing.stages }, 'b').route, null)
})

test('mergeRoutes: unknown ids warn, malformed values warn and fall through', () => {
  const parsed = parseMermaid(doc(null, ['flowchart TD', '  a["A"] --> b["B"]']))
  const resolved = buildFlow(parsed, {})
  const merged = mergeRoutes(resolved.stages, { ghost: 'kilo/kilo-auto/free', a: { provider: 'kilo' } }, null)
  assert.ok(has(merged.problems, 'FLOW_MODEL_UNKNOWN_STAGE'))
  assert.ok(has(merged.problems, 'FLOW_ROUTE_MALFORMED'))
  assert.equal(byId({ stages: merged.stages }, 'a').fallback, true)
})

test('mergeRoutes: an unresolved flow does not cascade unknown-stage warnings', () => {
  const merged = mergeRoutes([], { ghost: 'kilo/kilo-auto/free' }, null)
  assert.deepEqual(merged.problems, [])
})

// ─────────────────────────────── the session sentinel ───────────────────────────────

test('session_sentinel_needs_no_route_missing_warn', () => {
  const parsed = parseMermaid(doc(null, ['flowchart TD', '  a["A"] --> b["B"]']))
  const resolved = buildFlow(parsed, {})
  const merged = mergeRoutes(resolved.stages, { a: 'session' }, null)
  const codesFor = id => merged.problems.filter(problem => problem.node === id).map(problem => problem.code)
  assert.deepEqual(codesFor('a'), [], 'an explicit "session" is a decision, not a missing route')
  assert.deepEqual(codesFor('b'), ['FLOW_ROUTE_MISSING'], 'a route that is simply absent still warns')
})

test('session_sentinel_marks_route_source', () => {
  const flow = doc(['racing-code: 1', 'models:', '  a: session'], ['flowchart TD', '  a["A"] --> b["B"]'])
  const resolved = resolveFlow(flow, { allowedModels: [{ provider: 'kilo', model: 'kilo-auto/free' }] })
  const a = byId(resolved, 'a')
  assert.equal(a.route, null, 'the sentinel is not a route')
  assert.equal(a.routeSource, 'session')
  assert.equal(a.fallback, true)
  assert.equal(a.authorized, true, 'delegating on the session model needs no allowlist entry')
  assert.ok(!resolved.problems.some(problem => problem.code === 'FLOW_ROUTE_MISSING' && problem.node === 'a'))
  assert.ok(resolved.problems.some(problem => problem.code === 'FLOW_ROUTE_MISSING' && problem.node === 'b'))
})

const LANE_SESSION_GRAPH = [
  'flowchart TD',
  '  %% entry: start',
  '  start["Start"] --> race{{"Race"}}',
  '  race --> lane-a["Lane A"]',
  '  race --> lane-b["Lane B"]',
  '  lane-a --> cr["CR"]',
  '  lane-b --> cr',
  '  cr --> done["Done"]',
]

test('session_sentinel_runs_in_session_for_a_non_lane_stage', () => {
  const flow = doc(['racing-code: 1', 'models:', '  a: session'], ['flowchart TD', '  a["A"] --> b["B"]'])
  const resolved = resolveFlow(flow, {})
  const section = renderPolicySection({ ...resolved, file: '/tmp/doc/racing-code.md' })
  assert.match(section, /a=（在当前会话直接执行）/, 'a session route on a non-lane stage runs here, not in a child')
  assert.match(renderMermaid(resolved), /（在当前会话直接执行）/)
})

test('session_sentinel_inside_a_lane_still_delegates', () => {
  const models = ['racing-code: 1', 'models:', '  start: kilo/kilo-auto/free', '  lane-a: session',
    '  lane-b: kilo/kilo-auto/free', '  cr: kilo/kilo-auto/free', '  done: kilo/kilo-auto/free']
  const section = renderPolicySection(resolveFlow(doc(models, LANE_SESSION_GRAPH), {}))
  assert.match(section, /lane-a=（用当前会话模型委派）/, 'a lane keeps its own subagent and inherits the session model')
})

test('rules_text_splits_execution_by_route', () => {
  const section = renderPolicySection(resolveFlow(doc(null, ['flowchart TD', '  a["A"] --> b["B"]']), {}))
  assert.match(section, /声明/)
  assert.match(section, /provider\/model/)
  assert.match(section, /在当前会话直接执行/)
  assert.match(section, /lane 永远委派/)
  assert.doesNotMatch(section, /commit 阶段永远委派/, 'no stage-name exception in code')
})

test('commit_id_is_not_special_cased', () => {
  const flow = doc(null, ['flowchart TD', '  a["A"] --> commit["Commit"]'])
  const resolved = resolveFlow(flow, {})
  const section = renderPolicySection({ ...resolved, file: '/tmp/doc/racing-code.md' })
  assert.match(section, /commit=（在当前会话直接执行）/, 'the id must not decide the execution')
  assert.match(renderMermaid(resolved), /（在当前会话直接执行）/)
  const missing = resolved.problems.find(p => p.code === 'FLOW_ROUTE_MISSING' && p.node === 'commit')
  assert.match(missing.message, /在当前会话直接执行/)
})

test('rules_text_merges_decisions_into_user_gates', () => {
  const graph = ['flowchart TD', '  a["A"] --> v{"ok?"}', '  v -- "yes" --> d["D"]', '  v -- "no" --> a']
  const section = renderPolicySection(resolveFlow(doc(null, graph), {}))
  assert.match(section, /判定与用户关口同语义/)
  assert.match(section, /先给建议与依据/)
  assert.match(section, /完整材料/)
  assert.match(section, /等待给足/)
  assert.doesNotMatch(section, /判定自己下结论/, 'the old self-deciding clause must be gone')
})

test('route_missing_message_points_at_in_session_execution', () => {
  const flow = doc(['racing-code: 1', 'models:', '  b: kilo/kilo-auto/free'], ['flowchart TD', '  a["A"] --> b["B"]'])
  const missing = resolveFlow(flow, {}).problems.find(p => p.code === 'FLOW_ROUTE_MISSING' && p.node === 'a')
  assert.match(missing.message, /在当前会话直接执行/)
})

test('route_missing_message_for_a_lane_keeps_delegation', () => {
  const models = ['racing-code: 1', 'models:', '  start: kilo/kilo-auto/free',
    '  lane-b: kilo/kilo-auto/free', '  cr: kilo/kilo-auto/free', '  done: kilo/kilo-auto/free']
  const missing = resolveFlow(doc(models, LANE_SESSION_GRAPH), {})
    .problems.find(p => p.code === 'FLOW_ROUTE_MISSING' && p.node === 'lane-a')
  assert.match(missing.message, /委派时用当前会话模型/)
})

test('malformed_route_still_warns', () => {
  const flow = doc(['racing-code: 1', 'models:', "  a: 'not a route'"], ['flowchart TD', '  a["A"] --> b["B"]'])
  const resolved = resolveFlow(flow, {})
  assert.ok(resolved.problems.some(problem => problem.code === 'FLOW_ROUTE_MALFORMED' && problem.node === 'a'))
  const a = byId(resolved, 'a')
  assert.equal(a.routeSource, null)
  assert.equal(a.fallback, true)
  assert.ok(resolved.problems.some(problem => problem.code === 'FLOW_ROUTE_MISSING' && problem.node === 'a'))
})

test('checkAuthorized: allowlist membership, and no allowlist means no false alarms', () => {
  const stages = [
    { id: 'a', route: { provider: 'kilo', model: 'kilo-auto/free' }, authorized: true },
    { id: 'b', route: null, fallback: true, authorized: true },
  ]
  const denied = checkAuthorized(stages, [{ provider: 'opencode-go', model: 'mimo-v2.6-pro' }])
  assert.ok(has(denied.problems, 'FLOW_ROUTE_NOT_AUTHORIZED'))
  assert.equal(stages[0].authorized, false)
  assert.deepEqual(checkAuthorized(stages, null).problems, [])
})

test('checkReviewer: the CR must not reuse a lane model', () => {
  const stages = [
    { id: 'lane-a', route: { provider: 'kilo', model: 'kilo-auto/free' } },
    { id: 'cr', route: { provider: 'kilo', model: 'kilo-auto/free' } },
  ]
  const problems = checkReviewer(stages, [{ id: 'lane-a', joinAt: 'cr' }, { id: 'lane-b', joinAt: 'cr' }]).problems
  assert.ok(has(problems, 'FLOW_CR_MODEL_REUSED'))

  const fine = checkReviewer([
    { id: 'lane-a', route: { provider: 'kilo', model: 'kilo-auto/free' } },
    { id: 'cr', route: { provider: 'opencode-go', model: 'mimo-v2.6-pro' } },
  ], [{ id: 'lane-a', joinAt: 'cr' }]).problems
  assert.deepEqual(fine, [])
})

test('checkLabelShadowing: a route-looking second line that did not parse warns when another route wins', () => {
  const parsed = parseMermaid(doc(null, ['flowchart TD', '  a["A<br/>kilo · kilo-auto/free · high"] --> b["B"]']))
  const resolved = buildFlow(parsed, {})
  const merged = mergeRoutes(resolved.stages, { a: 'opencode-go/mimo-v2.6-pro' }, null)
  const problems = checkLabelShadowing(parsed.nodes, merged.stages).problems
  assert.ok(has(problems, 'FLOW_LABEL_ROUTE_SHADOWED'))
  assert.deepEqual(checkLabelShadowing(parsed.nodes, resolved.stages).problems, [])
})

// ─────────────────────────────── instructions, rendering, diagnostics ───────────────────────────────

test('attachInstructions: the stage id section becomes the prompt skeleton', () => {
  const parsed = parseMermaid(doc(null, LINEAR))
  const resolved = buildFlow(parsed, {})
  const { stages } = attachInstructions(resolved.stages, [
    '# Flow', '', '## Stage briefs', '', '### b', 'Implement against the contract.', '',
    '### c', 'Commit it.', '',
  ].join('\n'))
  assert.equal(byId({ stages }, 'b').instruction, 'Implement against the contract.')
  assert.equal(byId({ stages }, 'c').instruction, 'Commit it.')
  assert.equal(byId({ stages }, 'a').instruction, undefined)
})

test('renderPolicySection: never empty, and carries the diagram, routes and rules', () => {
  assert.equal(typeof renderPolicySection({}), 'string')
  assert.ok(renderPolicySection({}).length > 0)
  assert.ok(renderPolicySection({ ok: false, problems: [{ code: 'FLOW_FENCE_MISSING', level: 'error', message: 'no diagram' }] }).length > 0)

  const resolved = resolveFlow(REAL, {})
  const text = renderPolicySection({ ...resolved, file: '/tmp/doc/racing-code.md' })
  assert.match(text, /\/tmp\/doc\/racing-code\.md/)
  for (const stage of resolved.stages) assert.ok(text.includes(stage.id), `missing ${stage.id}`)
  assert.match(text, /\[race:/)
  assert.match(text, /worktree/)
  assert.match(text, /send_message/)
})

test('laneAgentName: <stem>-<model>, dropping a trailing single-letter lane ordinal', () => {
  assert.equal(
    laneAgentName('implement-a', { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }),
    'implement-deepseek-v4.1-flash')
  assert.equal(
    laneAgentName('implement-b', { provider: 'opencode-go', model: 'glm-5.3-flash' }),
    'implement-glm-5.3-flash')
})

test('laneAgentName: no ordinal, multi-hyphen ids and single letters keep a real stem', () => {
  assert.equal(laneAgentName('frontend', { model: 'glm-5.3-flash' }), 'frontend-glm-5.3-flash')
  assert.equal(laneAgentName('foo-bar-a', { model: 'm' }), 'foo-bar-m')
  assert.equal(laneAgentName('implement-x1', { model: 'm' }), 'implement-x1-m')
  assert.equal(laneAgentName('a', { model: 'm' }), 'a-m')
})

test('laneAgentName: a lane on the session model gets the session suffix', () => {
  assert.equal(laneAgentName('implement-a', null), 'implement-session')
  assert.equal(laneAgentName('implement-a', undefined), 'implement-session')
  assert.equal(laneAgentName('implement-a', { provider: 'opencode-go' }), 'implement-session')
})

test('laneAgentNameLine: one lane-id=name per lane stage, in declaration order', () => {
  const line = laneAgentNameLine(resolveFlow(REAL, {}).stages)
  assert.match(line, /^子代理显示名：/)
  assert.match(line, /implement-a=implement-deepseek-v4\.1-flash/)
  assert.match(line, /implement-b=implement-glm-5\.3-flash/)
})

test('laneAgentNameLine: a flow without lanes has no name line', () => {
  assert.equal(laneAgentNameLine(resolveFlow(doc(null, LINEAR), {}).stages), '')
  assert.equal(laneAgentNameLine([]), '')
})

test('laneAgentNameLine: a chained lane names every node on its own line, stems per node', () => {
  const graph = [
    'flowchart TD',
    '  %% entry: start',
    '  start["Start"] --> race{{"Race"}}',
    '  race --> pipe-a["A1<br/>opencode-go · deepseek-v4.1-flash"]',
    '  pipe-a --> pipe-a2["A2<br/>kilo · kilo-auto/free"]',
    '  race --> pipe-b["B<br/>opencode-go · glm-5.3-flash"]',
    '  pipe-a2 --> cr["CR<br/>opencode-go · mimo-v2.6-pro"]',
    '  pipe-b --> cr',
    '  cr --> done["Done<br/>kilo · kilo-auto/free"]',
  ]
  const line = laneAgentNameLine(resolveFlow(doc(null, graph), {}).stages)
  assert.equal(
    line,
    '子代理显示名：pipe-a=pipe-deepseek-v4.1-flash  pipe-a2=pipe-a2-kilo-auto/free  pipe-b=pipe-glm-5.3-flash')
  assert.equal(line.split('pipe-a=').length - 1, 1, 'the node id appears once, never once per stage')
})

test('renderPolicySection: the parallel-group rule pins the lane subagent name to its model', () => {
  const text = renderPolicySection({ ...resolveFlow(REAL, {}), file: '/tmp/doc/racing-code.md' })
  assert.match(text, /子代理显示名/)
  assert.match(text, /词干/)
  assert.match(text, /description/)
})

test('renderMermaid: round-trips — the rendering is itself a valid flow document', () => {
  const resolved = resolveFlow(REAL, {})
  const rendered = renderMermaid(resolved)
  assert.match(rendered, /^flowchart TD/)
  assert.match(rendered, /%% entry: design/)
  assert.match(rendered, /race\{\{/)
  const reparsed = parseMermaid(doc(null, rendered.split('\n')))
  assert.deepEqual(reparsed.problems, [])
  assert.deepEqual(reparsed.nodes.map(n => n.id).sort(), resolved.nodes.map(n => n.id).sort())
  assert.deepEqual(reparsed.edges.length, resolved.nodes.reduce((n, node) => n + node.next.length, 0))
})

test('diagnose and summarize: human sentences, and an unusable flow says why', () => {
  const broken = resolveFlow(doc(null, ['flowchart TD', '  a["A"] --> b["B"]', '  a --> c["C"]']))
  assert.equal(broken.ok, false)
  const lines = diagnose(broken.problems)
  assert.ok(lines.length > 0 && lines.every(l => l.includes('FLOW_')))
  assert.match(summarize(broken), /FLOW_/)

  const good = resolveFlow(REAL, {})
  assert.match(summarize(good), /design/)
})

// ─────────────────────────────── the real files ───────────────────────────────

test('the repository flow file resolves cleanly, with lanes and a review loop', () => {
  const resolved = resolveFlow(REAL, {
    allowedModels: [
      { provider: 'opencode-go', model: 'mimo-v2.6-pro' },
      { provider: 'opencode-go', model: 'glm-5.3-flash' },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      { provider: 'kilo', model: 'kilo-auto/free' },
    ],
  })
  only(resolved.problems)
  assert.deepEqual(resolved.problems.filter(p => p.level === 'error'), [])
  assert.equal(resolved.entry, 'design')
  assert.deepEqual(resolved.joins, [{ at: 'cr', lanes: ['implement-a', 'implement-b'] }])
  assert.deepEqual(
    resolved.loops.map(l => `${l.kind} ${l.via}->${l.backTo} ${l.maxRounds ?? l.maxRepeats}`).sort(),
    ['review confirm->race 2', 'stage confirm->design 3', 'stage final->design 3', 'stage gate->design 3'])
  assert.equal(byId(resolved, 'implement-a').lane.worktree, 'racing/implement-a')
  assert.equal(byId(resolved, 'implement-a').route.model, 'deepseek-v4.1-flash')
  assert.equal(byId(resolved, 'implement-a').authorized, true)
  assert.match(byId(resolved, 'cr').instruction, /评审/)
  assert.deepEqual(resolved.problems.map(p => p.code), [])
})

test('the repository flow file still resolves when the allowlist is unavailable', () => {
  const resolved = resolveFlow(REAL, { allowedModels: null })
  assert.equal(resolved.ok, true)
  assert.deepEqual(resolved.problems, [])
})
