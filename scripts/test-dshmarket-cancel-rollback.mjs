import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyDshmarketDesktopPatch } from './dshmarket-desktop-patch.mjs'

const marketDir = join(import.meta.dirname, '..', 'runtime', 'dsh', 'node_modules', 'dshmarket')
applyDshmarketDesktopPatch(marketDir)
applyDshmarketDesktopPatch(marketDir)

const { restoreManifestDeps } = await import('../runtime/dsh/node_modules/dshmarket/lib/profile.js')
const profileDir = mkdtempSync(join(tmpdir(), 'dshmarket-cancel-rollback-'))
try {
  const beforeDependencies = { 'existing-plugin': '1.0.0' }
  const beforeBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'existing-plugin', 'dshmarket']
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'fixture-profile',
    dependencies: { ...beforeDependencies, 'cancelled-plugin': '2.0.0' },
    dsh: { profile: { bundles: [...beforeBundles, 'cancelled-plugin'] } },
  }, null, 2)}\n`)

  const touched = restoreManifestDeps('web', beforeDependencies, profileDir, beforeBundles)
  const restored = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.deepEqual(restored.dependencies, beforeDependencies)
  assert.deepEqual(restored.dsh.profile.bundles, beforeBundles)
  assert.equal(touched.includes('cancelled-plugin'), true)

  const routes = readFileSync(join(marketDir, 'lib', 'routes.js'), 'utf8')
  assert.match(routes, /result\.exitCode !== 0 \|\| result\.timedOut \|\| cancelled/)
  assert.match(routes, /restoreManifestDeps\(config\.profile, manifestBefore, activeProfileDir, bundlesBefore\)/)
} finally {
  rmSync(profileDir, { recursive: true, force: true })
}

console.log('dshmarket cancelled install rollback tests passed')
