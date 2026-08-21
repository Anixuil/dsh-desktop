import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyDshmarketDesktopPatch } from './dshmarket-desktop-patch.mjs'

const root = join(import.meta.dirname, '..')
const markets = [
  join(root, 'runtime', 'dsh', 'node_modules', 'dshmarket'),
  join(root, 'runtime', 'plugins-src', 'dshmarket'),
].filter(path => existsSync(join(path, 'lib', 'routes.js')))

assert.ok(markets.length > 0, 'a bundled dshmarket copy is required')
for (const market of markets) {
  applyDshmarketDesktopPatch(market)
  applyDshmarketDesktopPatch(market)
  const routes = readFileSync(join(market, 'lib', 'routes.js'), 'utf8')
  assert.match(routes, /snapshotManagedArtifacts\(activeProfileDir\)/)
  assert.match(routes, /cleanupOwnedArtifacts\(activeProfileDir, name\)/)
  assert.match(routes, /clearSkillQuarantine\(activeProfileDir, skillQuarantines, name\)/)
}

const modulePath = join(markets[0], 'lib', 'managed-artifacts.js')
const {
  cleanupNewManagedArtifacts,
  cleanupOwnedArtifacts,
  readManagedArtifactOwnership,
  recordManagedArtifacts,
  snapshotManagedArtifacts,
} = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`)

const fixture = mkdtempSync(join(tmpdir(), 'dshmarket-artifacts-'))
const dshRoot = join(fixture, '.dsh')
const profile = join(dshRoot, 'profiles', 'web')
const presets = join(dshRoot, '.agent-presets')
mkdirSync(profile, { recursive: true })
mkdirSync(join(presets, 'user-owned'), { recursive: true })
writeFileSync(join(presets, 'user-owned', 'preset.yml'), 'name: User owned\n')

try {
  const before = snapshotManagedArtifacts(profile)
  mkdirSync(join(presets, 'liangshen'))
  writeFileSync(join(presets, 'liangshen', 'preset.yml'), 'name: 梁神模式\n')
  assert.deepEqual(recordManagedArtifacts(profile, ['@fixture/all'], before), {
    recorded: ['agent-presets/liangshen'],
  })
  assert.deepEqual(
    readManagedArtifactOwnership(profile).artifacts['agent-presets/liangshen'].owners,
    ['@fixture/all'],
  )

  const cleaned = cleanupOwnedArtifacts(profile, '@fixture/all')
  assert.deepEqual(cleaned.removed, ['agent-presets/liangshen'])
  assert.equal(existsSync(join(presets, 'liangshen')), false)
  assert.equal(existsSync(join(presets, 'user-owned')), true, 'pre-existing user preset must survive')

  const failedBefore = snapshotManagedArtifacts(profile)
  mkdirSync(join(presets, 'cancelled-plugin'))
  const rolledBack = cleanupNewManagedArtifacts(profile, failedBefore)
  assert.deepEqual(rolledBack.removed, ['agent-presets/cancelled-plugin'])
  assert.equal(existsSync(join(presets, 'cancelled-plugin')), false)

  const sharedBefore = snapshotManagedArtifacts(profile)
  mkdirSync(join(presets, 'shared-preset'))
  recordManagedArtifacts(profile, ['plugin-a', 'plugin-b'], sharedBefore)
  const first = cleanupOwnedArtifacts(profile, 'plugin-a')
  assert.deepEqual(first.released, ['agent-presets/shared-preset'])
  assert.equal(existsSync(join(presets, 'shared-preset')), true)
  const second = cleanupOwnedArtifacts(profile, 'plugin-b')
  assert.deepEqual(second.removed, ['agent-presets/shared-preset'])
  assert.equal(existsSync(join(presets, 'shared-preset')), false)

  const stateFile = join(profile, '.dsh-market', 'owned-artifacts.json')
  mkdirSync(join(profile, '.dsh-market'), { recursive: true })
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    artifacts: {
      '../escape': { root: 'agent-presets', name: '../escape', owners: ['bad-plugin'] },
    },
  }))
  assert.deepEqual(cleanupOwnedArtifacts(profile, 'bad-plugin').removed, [])
  assert.equal(existsSync(join(dshRoot, 'escape')), false)
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

console.log('dshmarket managed artifact cleanup tests passed')
