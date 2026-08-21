// @ts-nocheck - copied into dshmarket's compiled and source trees by the Desktop patch.
// Tracks only extension entries created while a market operation owns the mutation lock.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const STATE_VERSION = 1
const STATE_FILE = 'owned-artifacts.json'
const ENTRY_RE = /^[a-z0-9][a-z0-9-]*$/i
const MANAGED_ROOTS = Object.freeze([
  { key: 'agent-presets', relative: '.agent-presets' },
])

function dshRootForProfile(profileDirectory) {
  const absolute = resolve(profileDirectory)
  const profiles = dirname(absolute)
  if (basename(profiles).toLowerCase() === 'profiles') return dirname(profiles)
  const configured = process.env.DSH_HOME
  return resolve(configured === undefined || configured === '' ? join(process.env.USERPROFILE ?? '', '.dsh') : configured)
}

function stateFile(profileDirectory) {
  return join(profileDirectory, '.dsh-market', STATE_FILE)
}

function emptyState() {
  return { version: STATE_VERSION, artifacts: {} }
}

function readState(profileDirectory) {
  try {
    const value = JSON.parse(readFileSync(stateFile(profileDirectory), 'utf8'))
    if (value?.version !== STATE_VERSION || typeof value.artifacts !== 'object' || value.artifacts === null) return emptyState()
    const state = emptyState()
    for (const [id, record] of Object.entries(value.artifacts)) {
      if (typeof record !== 'object' || record === null) continue
      const root = MANAGED_ROOTS.find(item => item.key === record.root)
      if (root === undefined || typeof record.name !== 'string' || !ENTRY_RE.test(record.name)) continue
      const owners = Array.isArray(record.owners)
        ? [...new Set(record.owners.filter(owner => typeof owner === 'string' && owner !== ''))]
        : []
      if (owners.length === 0 || id !== `${root.key}/${record.name}`) continue
      state.artifacts[id] = { root: root.key, name: record.name, owners }
    }
    return state
  } catch {
    return emptyState()
  }
}

function writeState(profileDirectory, state) {
  const file = stateFile(profileDirectory)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  if (Object.keys(state.artifacts).length === 0) {
    rmSync(file, { force: true })
    return
  }
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
}

function managedDirectory(profileDirectory, root) {
  const dshRoot = dshRootForProfile(profileDirectory)
  const directory = resolve(dshRoot, root.relative)
  if (dirname(directory) !== dshRoot) throw new Error(`managed root escaped DSH_HOME: ${directory}`)
  return directory
}

function safeCandidate(profileDirectory, root, name) {
  if (!ENTRY_RE.test(name)) throw new Error(`invalid managed artifact name: ${name}`)
  const directory = managedDirectory(profileDirectory, root)
  const candidate = resolve(directory, name)
  if (dirname(candidate) !== directory) throw new Error(`managed artifact escaped its root: ${candidate}`)
  return candidate
}

function entriesAt(profileDirectory, root) {
  const directory = managedDirectory(profileDirectory, root)
  try {
    return readdirSync(directory, { withFileTypes: true })
      .map(entry => entry.name)
      .filter(name => ENTRY_RE.test(name))
      .sort()
  } catch {
    return []
  }
}

export function snapshotManagedArtifacts(profileDirectory) {
  const roots = {}
  for (const root of MANAGED_ROOTS) roots[root.key] = entriesAt(profileDirectory, root)
  return { version: STATE_VERSION, roots }
}

function newArtifacts(profileDirectory, before) {
  const result = []
  for (const root of MANAGED_ROOTS) {
    const previous = new Set(Array.isArray(before?.roots?.[root.key]) ? before.roots[root.key] : [])
    for (const name of entriesAt(profileDirectory, root)) {
      if (!previous.has(name)) result.push({ id: `${root.key}/${name}`, root, name })
    }
  }
  return result
}

function removeCandidate(profileDirectory, root, name) {
  const candidate = safeCandidate(profileDirectory, root, name)
  if (!existsSync(candidate)) return false
  const stat = lstatSync(candidate)
  rmSync(candidate, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true })
  return true
}

/** Record only entries absent before this install/enable operation. */
export function recordManagedArtifacts(profileDirectory, owners, before) {
  const normalizedOwners = [...new Set(owners.filter(owner => typeof owner === 'string' && owner !== ''))]
  if (normalizedOwners.length === 0) return { recorded: [] }
  const state = readState(profileDirectory)
  const recorded = []
  for (const artifact of newArtifacts(profileDirectory, before)) {
    const current = state.artifacts[artifact.id]
    const merged = [...new Set([...(current?.owners ?? []), ...normalizedOwners])]
    state.artifacts[artifact.id] = { root: artifact.root.key, name: artifact.name, owners: merged }
    recorded.push(artifact.id)
  }
  writeState(profileDirectory, state)
  return { recorded }
}

/** Roll back extension entries created by a failed or cancelled operation. */
export function cleanupNewManagedArtifacts(profileDirectory, before) {
  const removed = []
  const errors = []
  for (const artifact of newArtifacts(profileDirectory, before)) {
    try {
      if (removeCandidate(profileDirectory, artifact.root, artifact.name)) removed.push(artifact.id)
    } catch (error) {
      errors.push({ artifact: artifact.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { removed, errors }
}

/** Remove artifacts previously and exclusively attributed to one package. */
export function cleanupOwnedArtifacts(profileDirectory, owner) {
  const state = readState(profileDirectory)
  const removed = []
  const released = []
  const errors = []
  for (const [id, record] of Object.entries(state.artifacts)) {
    if (!record.owners.includes(owner)) continue
    const remaining = record.owners.filter(value => value !== owner)
    if (remaining.length > 0) {
      state.artifacts[id] = { ...record, owners: remaining }
      released.push(id)
      continue
    }
    const root = MANAGED_ROOTS.find(item => item.key === record.root)
    if (root === undefined) continue
    try {
      if (removeCandidate(profileDirectory, root, record.name)) removed.push(id)
      delete state.artifacts[id]
    } catch (error) {
      errors.push({ artifact: id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  writeState(profileDirectory, state)
  return { removed, released, errors }
}

export function readManagedArtifactOwnership(profileDirectory) {
  return readState(profileDirectory)
}
