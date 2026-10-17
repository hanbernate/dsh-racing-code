// Package guards: the shipped bundle is host-only, and the hand-written JS never
// reaches into an official implementation package.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
const manifest = JSON.parse(read('package.json'))

test('host-only bundle: no client half, no dependencies, no build', () => {
  assert.equal(manifest.dsh?.client, undefined, 'this plugin has no browser half')
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.main, 'lib/index.js')
  assert.deepEqual(Object.keys(manifest.scripts).sort(), ['prepublishOnly', 'test'])
})

test('the shipped patch inserts one row with the documented defaults and no global flow', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /id: racing-code/)
  assert.match(patch, /name: 'dsh-racing-code'/)
  for (const line of [
    'enabled: true',
    'projectFlowPath: doc/racing-code.md',
    'maxStageRepeats: 3',
    'maxLanes: 4',
    'maxReviewRounds: 2',
  ]) assert.ok(patch.includes(line), `patch is missing "${line}"`)
  for (const gone of ['routes', 'globalSkill', 'builtinFlowPath', 'syncAllowedModels', 'announceInPrompt']) {
    assert.ok(!patch.includes(gone), `patch must not configure the removed field "${gone}"`)
  }
})

test('lib/*.js is hand-written: no official implementation imports, no Node APIs in the pure layer', () => {
  const files = readdirSync(new URL('../lib', import.meta.url)).filter(name => name.endsWith('.js'))
  assert.ok(files.includes('flow.js'))
  for (const name of files) {
    const source = read(`lib/${name}`)
    assert.ok(!/from\s+['"]@deepseek-ai\//.test(source), `lib/${name} must not import official packages`)
    assert.ok(!/require\(/.test(source), `lib/${name} must stay ESM`)
    if (name === 'flow.js') {
      assert.ok(!/from\s+['"]node:/.test(source), 'lib/flow.js must stay pure (no Node APIs)')
      assert.ok(!/\bprocess\./.test(source), 'lib/flow.js must not touch process')
    }
  }
})

test('display metadata is shipped for both locales', () => {
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(read(`locale/${locale}.json`))
    assert.ok(meta.meta?.title, `${locale} needs meta.title`)
    assert.ok(meta.meta?.description, `${locale} needs meta.description`)
  }
  assert.ok(manifest.exports['./locale/*.json'], 'locale files must be exported for the plugin inventory')
})
