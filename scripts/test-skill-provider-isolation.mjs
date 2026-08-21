import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../runtime/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
import { SkillRegistry } from '../runtime/dsh/node_modules/@deepseek-ai/dsh-skill/lib/index.js'
import {
  addedSkillFailures,
  captureSkillFailures,
  clearSkillQuarantine,
  readSkillQuarantines,
  setSkillQuarantine,
} from '../runtime/dsh/node_modules/dshmarket/lib/skill-health.js'
import { applyDshSkillDesktopPatch } from './dsh-skill-desktop-patch.mjs'
import { applyDshmarketDesktopPatch } from './dshmarket-desktop-patch.mjs'

function candidate(name, provider) {
  return {
    name,
    description: `${name} fixture`,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'desktop-test',
    provider,
    rank: 1,
  }
}

const ctx = new Context()
const skills = new SkillRegistry(ctx)

assert.doesNotThrow(() => {
  skills.registerProvider(() => ({
    list: async () => [],
    get: async () => undefined,
  }))
}, 'a malformed provider contract must not fail plugin apply')

skills.registerProvider(() => ({
  name: 'broken-candidate-provider',
  list: async () => [candidate('broken-candidate', { wrong: true })],
  get: async () => undefined,
}))
skills.registerProvider(() => ({
  name: 'throwing-provider',
  list: async () => { throw new Error('temporary discovery failure') },
  get: async () => undefined,
}))
skills.registerProvider(() => ({
  name: 'healthy-provider',
  list: async () => [candidate('healthy-skill', 'healthy-provider')],
  get: async () => undefined,
}))

const snapshot = await skills.snapshot()
assert.deepEqual(snapshot.skills.map(skill => skill.name), ['healthy-skill'])
assert.equal(snapshot.complete, false)
assert.deepEqual(
  snapshot.failures.map(failure => failure.code).sort(),
  ['skill-provider-invalid-candidate', 'skill-provider-invalid-contract'],
)
assert.equal(snapshot.failures.some(failure => failure.skill === 'broken-candidate'), true)
assert.equal(snapshot.failures.some(failure => failure.message.includes('temporary discovery failure')), false)

const before = await captureSkillFailures(() => ({ snapshot: async () => ({ failures: [] }) }))
const after = await captureSkillFailures(() => ({ snapshot: async () => snapshot }))
const added = addedSkillFailures(before, after)
assert.equal(added.length, 2)

const profileDir = mkdtempSync(join(tmpdir(), 'dsh-skill-quarantine-'))
try {
  const quarantines = readSkillQuarantines(profileDir)
  setSkillQuarantine(profileDir, quarantines, 'fixture-plugin', added)
  const saved = readSkillQuarantines(profileDir)
  assert.equal(saved['fixture-plugin'].failures.length, 2)
  clearSkillQuarantine(profileDir, quarantines, 'fixture-plugin')
  assert.deepEqual(readSkillQuarantines(profileDir), {})
} finally {
  rmSync(profileDir, { recursive: true, force: true })
}

// Runtime acquisition applies both patches repeatedly. Keep that operation
// idempotent so a cached runtime is as safe as a freshly downloaded one.
applyDshSkillDesktopPatch(join(import.meta.dirname, '..', 'runtime', 'dsh', 'node_modules'))
applyDshSkillDesktopPatch(join(import.meta.dirname, '..', 'runtime', 'dsh', 'node_modules'))
applyDshmarketDesktopPatch(join(import.meta.dirname, '..', 'runtime', 'dsh', 'node_modules', 'dshmarket'))
applyDshmarketDesktopPatch(join(import.meta.dirname, '..', 'runtime', 'dsh', 'node_modules', 'dshmarket'))

console.log('skill provider isolation tests passed')
