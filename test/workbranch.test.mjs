// CONTRACT (RED): lane names take the working branch as a prefix (scheme B).
//
//   branch  = <workBranch>-racing/<lane-id>   (or racing/<lane-id> when unknown)
//   dir     = the branch when laneDir: branch, else <laneDir>/<lane-id>
//
// workBranch comes from front matter `workBranch` (wins), then resolveFlow opts,
// then detectWorkBranch() from the git worktree that holds the flow file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFlow } from '../lib/flow.js'
import { renderBootstrapTemplate, buildPlan } from '../lib/bootstrap.js'
import { detectWorkBranch } from '../lib/sources.js'

function flow({ front = [], lanes = ['impl-a', 'impl-b'] } = {}) {
  const lines = ['flowchart TD', '  %% entry: plan', '  plan["P"] --> race{{"race"}}']
  for (const id of lanes) lines.push(`  race --> ${id}["${id}"]`)
  lanes.forEach((id, index) => lines.push(index === 0 ? `  ${id} --> cr["CR"]` : `  ${id} --> cr`))
  lines.push('  cr --> done["done"]')
  return ['---', 'racing-code: 1', ...front, '---', '', '```mermaid', ...lines, '```'].join('\n')
}

const laneOf = (resolved, id) => resolved.stages.find(stage => stage.id === id).lane

function repoFs(files = {}, dirs = []) {
  const set = new Set(dirs)
  const notFound = () => { const error = new Error('FS_NOT_FOUND'); error.code = 'FS_NOT_FOUND'; return error }
  return {
    async resolve(path) {
      if (files[path] !== undefined || set.has(path)) return { path }
      throw notFound()
    },
    async readText(target) {
      const value = files[target.path]
      if (value === undefined) throw notFound()
      return value
    },
  }
}

test('workBranch: the branch is <workBranch>-racing/<id>, the default dir stays <laneDir>/<id>', () => {
  const resolved = resolveFlow(flow(), { workBranch: '0.0.x' })
  assert.equal(laneOf(resolved, 'impl-a').branch, '0.0.x-racing/impl-a')
  assert.equal(laneOf(resolved, 'impl-a').worktree, '.worktrees/impl-a')
})

test('workBranch: laneDir branch makes the directory equal to the branch', () => {
  const resolved = resolveFlow(flow({ front: ['laneDir: branch'] }), { workBranch: '0.0.x' })
  assert.equal(laneOf(resolved, 'impl-a').branch, '0.0.x-racing/impl-a')
  assert.equal(laneOf(resolved, 'impl-a').worktree, '0.0.x-racing/impl-a')
})

test('workBranch: absent means racing/<id>; empty string explicitly disables the prefix', () => {
  assert.equal(laneOf(resolveFlow(flow()), 'impl-a').branch, 'racing/impl-a')
  const off = resolveFlow(flow({ front: ['workBranch: ""'] }), { workBranch: 'ignored' })
  assert.equal(laneOf(off, 'impl-a').branch, 'racing/impl-a')
})

test('workBranch: front matter wins over the resolveFlow option', () => {
  const resolved = resolveFlow(flow({ front: ['workBranch: 0.4.x'] }), { workBranch: 'ignored' })
  assert.equal(laneOf(resolved, 'impl-a').branch, '0.4.x-racing/impl-a')
})

test('renderBootstrapTemplate: emits workBranch and names the first-run worktree commands', () => {
  const text = renderBootstrapTemplate({
    template: 'minimal', lanes: 2, laneDir: 'branch', workBranch: '0.0.x', generatedOn: '2026-10-18',
  })
  assert.match(text, /^workBranch: 0\.0\.x$/m)
  assert.match(text, /git worktree add 0\.0\.x-racing\/implement-a -b 0\.0\.x-racing\/implement-a/)
  const resolved = resolveFlow(text)
  assert.equal(laneOf(resolved, 'implement-a').branch, '0.0.x-racing/implement-a')
  assert.equal(laneOf(resolved, 'implement-a').worktree, '0.0.x-racing/implement-a')
})

test('buildPlan: the worktree fix carries the prefixed branch and directory', () => {
  const plan = buildPlan({
    file: '/p/docs/racing-code.md', fileExists: false, parentExists: true,
    gitLayout: 'worktree-container', laneDir: 'branch', workBranch: '0.0.x', gitignore: null,
    nodes: [{ id: 'implement-a', kind: 'lane' }, { id: 'implement-b', kind: 'lane' }],
    candidates: [],
  })
  const fix = plan.find(item => item.item === 'worktrees')?.fix ?? ''
  assert.match(fix, /git worktree add 0\.0\.x-racing\/implement-a -b 0\.0\.x-racing\/implement-a/)
})

test('detectWorkBranch: a normal repository reads .git/HEAD', async () => {
  const fs = repoFs({ '/repo/.git/HEAD': 'ref: refs/heads/0.0.x\n' }, ['/repo/.git'])
  assert.equal(await detectWorkBranch(fs, '/repo/docs/racing-code.md', '/repo'), '0.0.x')
})

test('detectWorkBranch: a worktree container resolves the gitdir of the branch worktree', async () => {
  const fs = repoFs({
    '/c/0.4.x/.git': 'gitdir: ../.bare/worktrees/0.4.x\n',
    '/c/.bare/worktrees/0.4.x/HEAD': 'ref: refs/heads/0.4.x\n',
  }, ['/c/0.4.x', '/c/.bare/worktrees/0.4.x'])
  assert.equal(await detectWorkBranch(fs, '/c/0.4.x/docs/racing-code.md', '/c'), '0.4.x')
})

test('detectWorkBranch: no git and detached HEAD both yield null', async () => {
  assert.equal(await detectWorkBranch(repoFs(), '/repo/docs/racing-code.md', '/repo'), null)
  const detached = repoFs({ '/repo/.git/HEAD': '0123456789abcdef\n' }, ['/repo/.git'])
  assert.equal(await detectWorkBranch(detached, '/repo/docs/racing-code.md', '/repo'), null)
})
