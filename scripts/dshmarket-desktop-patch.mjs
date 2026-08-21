import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PATCH_MARKER = 'dsh-desktop proxy fallback'
const MARKET_ORDER_PATCH_MARKER = 'dsh-desktop market order'
const LOG_PATCH_MARKER = 'dsh-desktop persistent diagnostics'
const SKILL_HEALTH_PATCH_MARKER = 'dsh-desktop skill health quarantine'
const CANCEL_ROLLBACK_PATCH_MARKER = 'dsh-desktop cancelled install rollback'
const RESIDUE_CLEANUP_PATCH_MARKER = 'dsh-desktop managed artifact cleanup'

function replaceOnce(source, needle, replacement, file) {
  if (!source.includes(needle)) {
    throw new Error(`dshmarket desktop patch no longer matches ${file}; update the patch for the bundled market version`)
  }
  return source.replace(needle, replacement)
}

function patchMarketSettingsOrder(marketDir) {
  const files = [
    join(marketDir, 'client', 'client.js'),
    join(marketDir, 'src', 'client', 'index.ts'),
  ]
  for (const file of files) {
    if (!existsSync(file)) continue
    let source = readFileSync(file, 'utf8')
    if (source.includes(MARKET_ORDER_PATCH_MARKER)) continue
    source = replaceOnce(
      source,
      'order: 40,',
      `order: 10, // ${MARKET_ORDER_PATCH_MARKER}: keep the market above remote access`,
      file,
    )
    writeFileSync(file, source)
  }
}

function patchPersistentDiagnostics(marketDir) {
  const logFile = join(marketDir, 'lib', 'log.js')
  const routesFile = join(marketDir, 'lib', 'routes.js')
  if (!existsSync(logFile) || !existsSync(routesFile)) return
  let logSource = readFileSync(logFile, 'utf8')
  let routesSource = readFileSync(routesFile, 'utf8')
  if (!logSource.includes(LOG_PATCH_MARKER)) {
    logSource = replaceOnce(
      logSource,
      "import { homedir } from 'node:os';",
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';\nimport { homedir } from 'node:os';\nimport { join } from 'node:path';",
      logFile,
    )
    logSource = replaceOnce(logSource, 'const entries = [];', 'const entries = [];\nlet storageFile = null;', logFile)
    logSource = replaceOnce(
      logSource,
      '    if (entries.length > MAX_ENTRIES)\n        entries.splice(0, entries.length - MAX_ENTRIES);\n}',
      `    if (entries.length > MAX_ENTRIES)
        entries.splice(0, entries.length - MAX_ENTRIES);
    if (storageFile !== null) {
        try { writeFileSync(storageFile, JSON.stringify(entries), 'utf8'); }
        catch { /* diagnostic logging must never break an operation */ }
    }
}

/** ${LOG_PATCH_MARKER}: preserve sanitized diagnostics over Desktop process replacement. */
export function configureLogStorage(profileDirectory) {
    storageFile = join(profileDirectory, '.dsh-market-session-log.json');
    try {
        if (!existsSync(storageFile)) return;
        const saved = JSON.parse(readFileSync(storageFile, 'utf8'));
        if (!Array.isArray(saved)) return;
        for (const entry of saved.slice(-MAX_ENTRIES)) {
            if (typeof entry !== 'object' || entry === null) continue;
            if (typeof entry.at !== 'string' || typeof entry.event !== 'string' || typeof entry.detail !== 'string'
                || !['info', 'warn', 'error'].includes(entry.level)) continue;
            entries.push({ at: entry.at, level: entry.level, event: sanitize(entry.event), detail: sanitize(entry.detail).slice(0, DETAIL_MAX) });
        }
        if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    }
    catch { /* a corrupt diagnostic file is not an application failure */ }
}`,
      logFile,
    )
  }
  if (!routesSource.includes(LOG_PATCH_MARKER)) {
    routesSource = replaceOnce(routesSource, "import { exportLogs, logEvent } from './log.js';", "import { configureLogStorage, exportLogs, logEvent } from './log.js';", routesFile)
    routesSource = replaceOnce(routesSource, '    const activeProfileDir = profileDir(config.profile, config.profileDirectory);', `    const activeProfileDir = profileDir(config.profile, config.profileDirectory);
        configureLogStorage(activeProfileDir); // ${LOG_PATCH_MARKER}`, routesFile)
    routesSource = replaceOnce(routesSource, "                        if (target === null) {\n                            sendJson(response, 400, { error: 'unsupported source url' });", "                        if (target === null) {\n                            logEvent('warn', 'install-rejected', `${entry.name}: unsupported source url`);\n                            sendJson(response, 400, { error: 'unsupported source url' });", routesFile)
    routesSource = replaceOnce(routesSource, "                        // Duplicate guard (#27):", "                        logEvent('info', 'install-requested', `${entry.name} -> ${target}`);\n                        // Duplicate guard (#27):", routesFile)
  }
  writeFileSync(logFile, logSource)
  writeFileSync(routesFile, routesSource)
}

function patchCancelledInstallRollback(marketDir) {
  const profileFiles = [
    join(marketDir, 'lib', 'profile.js'),
    join(marketDir, 'src', 'profile.ts'),
  ]
  for (const file of profileFiles) {
    if (!existsSync(file)) continue
    let source = readFileSync(file, 'utf8')
    if (source.includes(CANCEL_ROLLBACK_PATCH_MARKER)) continue
    const ts = file.endsWith('.ts')
    source = replaceOnce(
      source,
      ts
        ? `export function restoreManifestDeps(profile: string, snapshot: Record<string, string>, explicitDir?: string): string[] {\n  const file = join(profileDir(profile, explicitDir), 'package.json')\n  let manifest: { dependencies?: Record<string, string> }\n  try {\n    manifest = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string> }`
        : `export function restoreManifestDeps(profile, snapshot, explicitDir) {\n    const file = join(profileDir(profile, explicitDir), 'package.json');\n    let manifest;\n    try {\n        manifest = JSON.parse(readFileSync(file, 'utf8'));`,
      ts
        ? `/** ${CANCEL_ROLLBACK_PATCH_MARKER}: restore both package and loader state. */\nexport function restoreManifestDeps(profile: string, snapshot: Record<string, string>, explicitDir?: string, bundleSnapshot?: string[]): string[] {\n  const file = join(profileDir(profile, explicitDir), 'package.json')\n  let manifest: { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }\n  try {\n    manifest = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }`
        : `/** ${CANCEL_ROLLBACK_PATCH_MARKER}: restore both package and loader state. */\nexport function restoreManifestDeps(profile, snapshot, explicitDir, bundleSnapshot) {\n    const file = join(profileDir(profile, explicitDir), 'package.json');\n    let manifest;\n    try {\n        manifest = JSON.parse(readFileSync(file, 'utf8'));`,
      file,
    )
    source = replaceOnce(
      source,
      ts
        ? `  for (const name of Object.keys(snapshot)) if (current[name] !== snapshot[name]) touched.add(name)\n  if (touched.size === 0) return []\n  manifest.dependencies = { ...snapshot }\n  writeFileSync(file, \`${'${JSON.stringify(manifest, null, 2)}'}\\n\`)`
        : `    for (const name of Object.keys(snapshot))\n        if (current[name] !== snapshot[name])\n            touched.add(name);\n    if (touched.size === 0)\n        return [];\n    manifest.dependencies = { ...snapshot };\n    writeFileSync(file, \`${'${JSON.stringify(manifest, null, 2)}'}\\n\`);`,
      ts
        ? `  for (const name of Object.keys(snapshot)) if (current[name] !== snapshot[name]) touched.add(name)\n  const currentBundles = manifest.dsh?.profile?.bundles\n  if (bundleSnapshot !== undefined && Array.isArray(currentBundles)) {\n    const before = new Set(bundleSnapshot)\n    const after = new Set(currentBundles)\n    for (const name of currentBundles) if (!before.has(name)) touched.add(name)\n    for (const name of bundleSnapshot) if (!after.has(name)) touched.add(name)\n  }\n  if (touched.size === 0) return []\n  manifest.dependencies = { ...snapshot }\n  if (bundleSnapshot !== undefined) {\n    manifest.dsh ??= {}\n    manifest.dsh.profile ??= {}\n    manifest.dsh.profile.bundles = [...bundleSnapshot]\n  }\n  writeFileSync(file, \`${'${JSON.stringify(manifest, null, 2)}'}\\n\`)`
        : `    for (const name of Object.keys(snapshot))\n        if (current[name] !== snapshot[name])\n            touched.add(name);\n    const currentBundles = manifest.dsh?.profile?.bundles;\n    if (bundleSnapshot !== undefined && Array.isArray(currentBundles)) {\n        const before = new Set(bundleSnapshot);\n        const after = new Set(currentBundles);\n        for (const name of currentBundles)\n            if (!before.has(name))\n                touched.add(name);\n        for (const name of bundleSnapshot)\n            if (!after.has(name))\n                touched.add(name);\n    }\n    if (touched.size === 0)\n        return [];\n    manifest.dependencies = { ...snapshot };\n    if (bundleSnapshot !== undefined) {\n        manifest.dsh ??= {};\n        manifest.dsh.profile ??= {};\n        manifest.dsh.profile.bundles = [...bundleSnapshot];\n    }\n    writeFileSync(file, \`${'${JSON.stringify(manifest, null, 2)}'}\\n\`);`,
      file,
    )
    writeFileSync(file, source)
  }

  const typeFile = join(marketDir, 'lib', 'types', 'profile.d.ts')
  if (existsSync(typeFile)) {
    let source = readFileSync(typeFile, 'utf8')
    if (!source.includes(CANCEL_ROLLBACK_PATCH_MARKER)) {
      source = replaceOnce(
        source,
        `export declare function restoreManifestDeps(profile: string, snapshot: Record<string, string>, explicitDir?: string): string[];`,
        `/** ${CANCEL_ROLLBACK_PATCH_MARKER}: restore both package and loader state. */\nexport declare function restoreManifestDeps(profile: string, snapshot: Record<string, string>, explicitDir?: string, bundleSnapshot?: string[]): string[];`,
        typeFile,
      )
      writeFileSync(typeFile, source)
    }
  }

  const routeFiles = [
    join(marketDir, 'lib', 'routes.js'),
    join(marketDir, 'src', 'routes.ts'),
  ]
  for (const file of routeFiles) {
    if (!existsSync(file)) continue
    let source = readFileSync(file, 'utf8')
    if (source.includes(CANCEL_ROLLBACK_PATCH_MARKER)) continue
    const ts = file.endsWith('.ts')
    source = replaceOnce(
      source,
      ts
        ? `            // RAW manifest snapshot for failure rollback (#65): pnpm writes\n            // package.json before the build-script check / registry fetches\n            // run, so a hard-failed add leaves ghost dependencies that break\n            // every later pnpm run — of anything. Cancelled runs keep their\n            // partial state on purpose (the user sees the diff and decides).\n            const manifestBefore = readManifestDeps(config.profile, activeProfileDir)\n            const result = await runPlugin(config.profile, ['add', target])\n            const cancelled = result.cancelled\n            if ((result.exitCode !== 0 || result.timedOut) && !cancelled) {\n              const rolledBack = restoreManifestDeps(config.profile, manifestBefore, activeProfileDir)`
        : `                        // RAW manifest snapshot for failure rollback (#65): pnpm writes\n                        // package.json before the build-script check / registry fetches\n                        // run, so a hard-failed add leaves ghost dependencies that break\n                        // every later pnpm run — of anything. Cancelled runs keep their\n                        // partial state on purpose (the user sees the diff and decides).\n                        const manifestBefore = readManifestDeps(config.profile, activeProfileDir);\n                        const result = await runPlugin(config.profile, ['add', target]);\n                        const cancelled = result.cancelled;\n                        if ((result.exitCode !== 0 || result.timedOut) && !cancelled) {\n                            const rolledBack = restoreManifestDeps(config.profile, manifestBefore, activeProfileDir);`,
      ts
        ? `            // ${CANCEL_ROLLBACK_PATCH_MARKER}: cancel means no durable profile mutation.\n            const manifestBefore = readManifestDeps(config.profile, activeProfileDir)\n            const bundlesBefore = readProfileBundles(activeProfileDir)\n            const result = await runPlugin(config.profile, ['add', target])\n            const cancelled = result.cancelled\n            if (result.exitCode !== 0 || result.timedOut || cancelled) {\n              const rolledBack = restoreManifestDeps(config.profile, manifestBefore, activeProfileDir, bundlesBefore)`
        : `                        // ${CANCEL_ROLLBACK_PATCH_MARKER}: cancel means no durable profile mutation.\n                        const manifestBefore = readManifestDeps(config.profile, activeProfileDir);\n                        const bundlesBefore = readProfileBundles(activeProfileDir);\n                        const result = await runPlugin(config.profile, ['add', target]);\n                        const cancelled = result.cancelled;\n                        if (result.exitCode !== 0 || result.timedOut || cancelled) {\n                            const rolledBack = restoreManifestDeps(config.profile, manifestBefore, activeProfileDir, bundlesBefore);`,
      file,
    )
    writeFileSync(file, source)
  }
}

function patchManagedArtifactCleanup(marketDir) {
  const templateFile = new URL('./dshmarket-residue.template.js', import.meta.url)
  const template = readFileSync(templateFile, 'utf8')
  for (const file of [join(marketDir, 'lib', 'managed-artifacts.js'), join(marketDir, 'src', 'managed-artifacts.ts')]) {
    writeFileSync(file, template)
  }

  for (const file of [join(marketDir, 'lib', 'routes.js'), join(marketDir, 'src', 'routes.ts')]) {
    if (!existsSync(file)) continue
    let source = readFileSync(file, 'utf8')
    if (source.includes(RESIDUE_CLEANUP_PATCH_MARKER)) continue
    const ts = file.endsWith('.ts')
    const extension = ts ? 'ts' : 'js'

    source = replaceOnce(
      source,
      ts
        ? `import { addedSkillFailures, captureSkillFailures, clearSkillQuarantine, readSkillQuarantines, setSkillQuarantine } from './skill-health.ts' // ${SKILL_HEALTH_PATCH_MARKER}`
        : `import { addedSkillFailures, captureSkillFailures, clearSkillQuarantine, readSkillQuarantines, setSkillQuarantine } from './skill-health.js'; // ${SKILL_HEALTH_PATCH_MARKER}`,
      ts
        ? `import { addedSkillFailures, captureSkillFailures, clearSkillQuarantine, readSkillQuarantines, setSkillQuarantine } from './skill-health.ts' // ${SKILL_HEALTH_PATCH_MARKER}\nimport { cleanupNewManagedArtifacts, cleanupOwnedArtifacts, recordManagedArtifacts, snapshotManagedArtifacts } from './managed-artifacts.${extension}' // ${RESIDUE_CLEANUP_PATCH_MARKER}`
        : `import { addedSkillFailures, captureSkillFailures, clearSkillQuarantine, readSkillQuarantines, setSkillQuarantine } from './skill-health.js'; // ${SKILL_HEALTH_PATCH_MARKER}\nimport { cleanupNewManagedArtifacts, cleanupOwnedArtifacts, recordManagedArtifacts, snapshotManagedArtifacts } from './managed-artifacts.${extension}'; // ${RESIDUE_CLEANUP_PATCH_MARKER}`,
      file,
    )

    source = replaceOnce(
      source,
      ts
        ? `    const failuresBefore = enabled ? await captureSkillFailures(skillsLookup) : new Map()`
        : `        const failuresBefore = enabled ? await captureSkillFailures(skillsLookup) : new Map();`,
      ts
        ? `    const failuresBefore = enabled ? await captureSkillFailures(skillsLookup) : new Map()\n    const managedBefore = enabled ? snapshotManagedArtifacts(dir) : null`
        : `        const failuresBefore = enabled ? await captureSkillFailures(skillsLookup) : new Map();\n        const managedBefore = enabled ? snapshotManagedArtifacts(dir) : null;`,
      file,
    )

    source = replaceOnce(
      source,
      ts
        ? `        logEvent('warn', 'skill-quarantine', \`${'${name}'}: ${'${failures.map(failure => failure.message).join("; ")}'}\`)\n        return { ok: false, quarantined: true, reason: \`插件返回了无效的 Skill 元数据，已自动隔离；对话可继续使用。 / The plugin returned invalid Skill metadata and was quarantined; conversations can continue. ${'${failures[0].message}'}\` }`
        : `                logEvent('warn', 'skill-quarantine', \`${'${name}'}: ${'${failures.map(failure => failure.message).join("; ")}'}\`);\n                return { ok: false, quarantined: true, reason: \`插件返回了无效的 Skill 元数据，已自动隔离；对话可继续使用。 / The plugin returned invalid Skill metadata and was quarantined; conversations can continue. ${'${failures[0].message}'}\` };`,
      ts
        ? `        logEvent('warn', 'skill-quarantine', \`${'${name}'}: ${'${failures.map(failure => failure.message).join("; ")}'}\`)\n        if (managedBefore !== null) cleanupNewManagedArtifacts(dir, managedBefore)\n        return { ok: false, quarantined: true, reason: \`插件返回了无效的 Skill 元数据，已自动隔离；对话可继续使用。 / The plugin returned invalid Skill metadata and was quarantined; conversations can continue. ${'${failures[0].message}'}\` }`
        : `                logEvent('warn', 'skill-quarantine', \`${'${name}'}: ${'${failures.map(failure => failure.message).join("; ")}'}\`);\n                if (managedBefore !== null) cleanupNewManagedArtifacts(dir, managedBefore);\n                return { ok: false, quarantined: true, reason: \`插件返回了无效的 Skill 元数据，已自动隔离；对话可继续使用。 / The plugin returned invalid Skill metadata and was quarantined; conversations can continue. ${'${failures[0].message}'}\` };`,
      file,
    )

    source = replaceOnce(
      source,
      ts
        ? `      clearSkillQuarantine(dir, skillQuarantines, name)\n    }\n    writeMarketState(dir, { disabled, groups, groupOrder })`
        : `            clearSkillQuarantine(dir, skillQuarantines, name);\n        }\n        writeMarketState(dir, { disabled, groups, groupOrder });`,
      ts
        ? `      clearSkillQuarantine(dir, skillQuarantines, name)\n    }\n    if (managedBefore !== null) {\n      const artifacts = ok\n        ? recordManagedArtifacts(dir, [name], managedBefore)\n        : cleanupNewManagedArtifacts(dir, managedBefore)\n      const changed = [...(artifacts.recorded ?? []), ...(artifacts.removed ?? [])]\n      if (changed.length > 0) logEvent('info', 'artifact-ownership', \`${'${name}'}: ${'${changed.join(", ")}'}\`)\n    }\n    writeMarketState(dir, { disabled, groups, groupOrder })`
        : `            clearSkillQuarantine(dir, skillQuarantines, name);\n        }\n        if (managedBefore !== null) {\n            const artifacts = ok\n                ? recordManagedArtifacts(dir, [name], managedBefore)\n                : cleanupNewManagedArtifacts(dir, managedBefore);\n            const changed = [...(artifacts.recorded ?? []), ...(artifacts.removed ?? [])];\n            if (changed.length > 0)\n                logEvent('info', 'artifact-ownership', \`${'${name}'}: ${'${changed.join(", ")}'}\`);\n        }\n        writeMarketState(dir, { disabled, groups, groupOrder });`,
      file,
    )

    source = replaceOnce(
      source,
      ts
        ? `            const manifestBefore = readManifestDeps(config.profile, activeProfileDir)\n            const bundlesBefore = readProfileBundles(activeProfileDir)\n            const result = await runPlugin(config.profile, ['add', target])`
        : `                        const manifestBefore = readManifestDeps(config.profile, activeProfileDir);\n                        const bundlesBefore = readProfileBundles(activeProfileDir);\n                        const result = await runPlugin(config.profile, ['add', target]);`,
      ts
        ? `            const manifestBefore = readManifestDeps(config.profile, activeProfileDir)\n            const bundlesBefore = readProfileBundles(activeProfileDir)\n            const managedBefore = snapshotManagedArtifacts(activeProfileDir)\n            const result = await runPlugin(config.profile, ['add', target])`
        : `                        const manifestBefore = readManifestDeps(config.profile, activeProfileDir);\n                        const bundlesBefore = readProfileBundles(activeProfileDir);\n                        const managedBefore = snapshotManagedArtifacts(activeProfileDir);\n                        const result = await runPlugin(config.profile, ['add', target]);`,
      file,
    )

    source = replaceOnce(
      source,
      ts
        ? `            logEvent(ok || cancelled ? 'info' : 'error', 'install',`
        : `                        logEvent(ok || cancelled ? 'info' : 'error', 'install',`,
      ts
        ? `            const artifactResult = ok && addedPackages.length > 0\n              ? recordManagedArtifacts(activeProfileDir, addedPackages, managedBefore)\n              : cleanupNewManagedArtifacts(activeProfileDir, managedBefore)\n            const artifactChanges = [...(artifactResult.recorded ?? []), ...(artifactResult.removed ?? [])]\n            if (artifactChanges.length > 0) logEvent('info', 'artifact-cleanup', \`${'${target}'}: ${'${artifactChanges.join(", ")}'}\`)\n            logEvent(ok || cancelled ? 'info' : 'error', 'install',`
        : `                        const artifactResult = ok && addedPackages.length > 0\n                            ? recordManagedArtifacts(activeProfileDir, addedPackages, managedBefore)\n                            : cleanupNewManagedArtifacts(activeProfileDir, managedBefore);\n                        const artifactChanges = [...(artifactResult.recorded ?? []), ...(artifactResult.removed ?? [])];\n                        if (artifactChanges.length > 0)\n                            logEvent('info', 'artifact-cleanup', \`${'${target}'}: ${'${artifactChanges.join(", ")}'}\`);\n                        logEvent(ok || cancelled ? 'info' : 'error', 'install',`,
      file,
    )

    source = replaceOnce(
      source,
      ts
        ? `            let hot = false\n            if (ok) {`
        : `                        let hot = false;\n                        if (ok) {`,
      ts
        ? `            let hot = false\n            let artifactCleanup = { removed: [], released: [], errors: [] }\n            if (ok) {`
        : `                        let hot = false;\n                        let artifactCleanup = { removed: [], released: [], errors: [] };\n                        if (ok) {`,
      file,
    )

    source = replaceOnce(
      source,
      ts
        ? `              writeMarketState(activeProfileDir, { disabled, groups, groupOrder })\n            }\n            logEvent(ok || cancelled ? 'info' : 'error', 'uninstall',`
        : `                            writeMarketState(activeProfileDir, { disabled, groups, groupOrder });\n                        }\n                        logEvent(ok || cancelled ? 'info' : 'error', 'uninstall',`,
      ts
        ? `              writeMarketState(activeProfileDir, { disabled, groups, groupOrder })\n              clearSkillQuarantine(activeProfileDir, skillQuarantines, name)\n              artifactCleanup = cleanupOwnedArtifacts(activeProfileDir, name)\n              if (artifactCleanup.removed.length > 0) logEvent('info', 'artifact-cleanup', \`${'${name}'}: removed ${'${artifactCleanup.removed.join(", ")}'}\`)\n            }\n            logEvent(ok || cancelled ? 'info' : 'error', 'uninstall',`
        : `                            writeMarketState(activeProfileDir, { disabled, groups, groupOrder });\n                            clearSkillQuarantine(activeProfileDir, skillQuarantines, name);\n                            artifactCleanup = cleanupOwnedArtifacts(activeProfileDir, name);\n                            if (artifactCleanup.removed.length > 0)\n                                logEvent('info', 'artifact-cleanup', \`${'${name}'}: removed ${'${artifactCleanup.removed.join(", ")}'}\`);\n                        }\n                        logEvent(ok || cancelled ? 'info' : 'error', 'uninstall',`,
      file,
    )

    source = replaceOnce(
      source,
      ts
        ? `              hot,\n              partial: cancelDiff?.partial,`
        : `                            hot,\n                            partial: cancelDiff?.partial,`,
      ts
        ? `              hot,\n              cleanup: artifactCleanup,\n              partial: cancelDiff?.partial,`
        : `                            hot,\n                            cleanup: artifactCleanup,\n                            partial: cancelDiff?.partial,`,
      file,
    )

    writeFileSync(file, source)
  }
}

function skillHealthModule() {
  return `// @ts-nocheck - generated Desktop compatibility shim, validated against the compiled runtime
/** ${SKILL_HEALTH_PATCH_MARKER}: isolate plugins that register malformed Skill Providers. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const FILE = 'skill-quarantine.json'

function normalizedFailure(value) {
  if (value === null || typeof value !== 'object') return null
  const failure = value
  if (failure.code !== 'skill-provider-invalid-contract' && failure.code !== 'skill-provider-invalid-candidate') return null
  if (typeof failure.message !== 'string' || failure.message === '') return null
  return {
    code: failure.code,
    provider: typeof failure.provider === 'string' ? failure.provider : null,
    skill: typeof failure.skill === 'string' ? failure.skill : null,
    message: failure.message,
    at: typeof failure.at === 'string' ? failure.at : new Date().toISOString(),
  }
}

export function failureKey(failure) {
  return JSON.stringify([failure.code, failure.provider, failure.skill, failure.message])
}

export async function captureSkillFailures(lookup) {
  const result = new Map()
  try {
    const registry = lookup?.()
    if (registry === undefined || typeof registry.snapshot !== 'function') return result
    const snapshot = await registry.snapshot()
    const failures = Array.isArray(snapshot?.failures)
      ? snapshot.failures
      : typeof registry.diagnostics === 'function' ? registry.diagnostics() : []
    for (const value of failures) {
      const failure = normalizedFailure(value)
      if (failure !== null) result.set(failureKey(failure), failure)
    }
  } catch { /* diagnostics must never block plugin operations */ }
  return result
}

export function addedSkillFailures(before, after) {
  return [...after.entries()].filter(([key]) => !before.has(key)).map(([, failure]) => failure)
}

function fileFor(profileDir) { return join(profileDir, '.dsh-market', FILE) }

export function readSkillQuarantines(profileDir) {
  try {
    const value = JSON.parse(readFileSync(fileFor(profileDir), 'utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    const result = {}
    for (const [name, record] of Object.entries(value)) {
      if (name === '' || record === null || typeof record !== 'object' || !Array.isArray(record.failures)) continue
      const failures = record.failures.map(normalizedFailure).filter(Boolean)
      if (failures.length > 0) result[name] = { package: name, failures, at: typeof record.at === 'string' ? record.at : failures[0].at }
    }
    return result
  } catch { return {} }
}

export function writeSkillQuarantines(profileDir, records) {
  const file = fileFor(profileDir)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(records), 'utf8')
  renameSync(tmp, file)
}

export function setSkillQuarantine(profileDir, records, packageName, failures) {
  records[packageName] = { package: packageName, failures, at: new Date().toISOString() }
  writeSkillQuarantines(profileDir, records)
}

export function clearSkillQuarantine(profileDir, records, packageName) {
  if (records[packageName] === undefined) return
  delete records[packageName]
  writeSkillQuarantines(profileDir, records)
}
`
}

function patchSkillHealth(marketDir) {
  const moduleSource = skillHealthModule()
  writeFileSync(join(marketDir, 'lib', 'skill-health.js'), moduleSource)
  if (existsSync(join(marketDir, 'src'))) writeFileSync(join(marketDir, 'src', 'skill-health.ts'), moduleSource)

  const indexFiles = [join(marketDir, 'lib', 'index.js'), join(marketDir, 'src', 'index.ts')]
  for (const file of indexFiles) {
    if (!existsSync(file)) continue
    let source = readFileSync(file, 'utf8')
    if (source.includes(SKILL_HEALTH_PATCH_MARKER)) continue
    source = replaceOnce(
      source,
      file.endsWith('.ts')
        ? `function agentsLookupOf(ctx: Context): () => AgentsServiceLike | undefined {\n  return () => ctx.get('agents') as AgentsServiceLike | undefined\n}`
        : `function agentsLookupOf(ctx) {\n    return () => ctx.get('agents');\n}`,
      file.endsWith('.ts')
        ? `function agentsLookupOf(ctx: Context): () => AgentsServiceLike | undefined {\n  return () => ctx.get('agents') as AgentsServiceLike | undefined\n}\n\n/** ${SKILL_HEALTH_PATCH_MARKER}: resolve the registry lazily after all host services mount. */\nfunction skillsLookupOf(ctx: Context): () => unknown {\n  return () => ctx.get('skills')\n}`
        : `function agentsLookupOf(ctx) {\n    return () => ctx.get('agents');\n}\n/** ${SKILL_HEALTH_PATCH_MARKER}: resolve the registry lazily after all host services mount. */\nfunction skillsLookupOf(ctx) {\n    return () => ctx.get('skills');\n}`,
      file,
    )
    source = source.replaceAll('mountMarketRoutes(host, resolved, undefined, agentsLookupOf(ctx))', 'mountMarketRoutes(host, resolved, undefined, agentsLookupOf(ctx), skillsLookupOf(ctx))')
    source = source.replaceAll('mountMarketRoutes(host, resolved, runtime, agentsLookupOf(ctx))', 'mountMarketRoutes(host, resolved, runtime, agentsLookupOf(ctx), skillsLookupOf(ctx))')
    writeFileSync(file, source)
  }

  const routeFiles = [join(marketDir, 'lib', 'routes.js'), join(marketDir, 'src', 'routes.ts')]
  for (const file of routeFiles) {
    if (!existsSync(file)) continue
    let source = readFileSync(file, 'utf8')
    if (source.includes(SKILL_HEALTH_PATCH_MARKER)) continue
    const ext = file.endsWith('.ts') ? 'ts' : 'js'
    source = replaceOnce(
      source,
      ext === 'ts'
        ? `import {\n  createGist, fitsGistLimit, GistError, gistErrorCode, parseGistId, readGist, resolveGistTokenSource, updateGist, verifyGistToken,\n} from './gist.ts'`
        : `import { createGist, fitsGistLimit, GistError, gistErrorCode, parseGistId, readGist, resolveGistTokenSource, updateGist, verifyGistToken, } from './gist.js';`,
      (ext === 'ts'
        ? `import {\n  createGist, fitsGistLimit, GistError, gistErrorCode, parseGistId, readGist, resolveGistTokenSource, updateGist, verifyGistToken,\n} from './gist.ts'\nimport { addedSkillFailures, captureSkillFailures, clearSkillQuarantine, readSkillQuarantines, setSkillQuarantine } from './skill-health.ts' // ${SKILL_HEALTH_PATCH_MARKER}`
        : `import { createGist, fitsGistLimit, GistError, gistErrorCode, parseGistId, readGist, resolveGistTokenSource, updateGist, verifyGistToken, } from './gist.js';\nimport { addedSkillFailures, captureSkillFailures, clearSkillQuarantine, readSkillQuarantines, setSkillQuarantine } from './skill-health.js'; // ${SKILL_HEALTH_PATCH_MARKER}`),
      file,
    )
    if (ext === 'ts') {
      source = replaceOnce(source, `  agentsLookup?: AgentsLookup,\n): () => void {`, `  agentsLookup?: AgentsLookup,\n  skillsLookup?: () => unknown,\n): () => void {`, file)
    } else {
      source = replaceOnce(source, `export function mountMarketRoutes(host, config, commandRuntime, agentsLookup) {`, `export function mountMarketRoutes(host, config, commandRuntime, agentsLookup, skillsLookup) {`, file)
    }
    source = replaceOnce(
      source,
      ext === 'ts' ? `  const marketState = readMarketState(activeProfileDir)\n  const disabled = marketState.disabled` : `    const marketState = readMarketState(activeProfileDir);\n    const disabled = marketState.disabled;`,
      ext === 'ts'
        ? `  const marketState = readMarketState(activeProfileDir)\n  const skillQuarantines = readSkillQuarantines(activeProfileDir)\n  const disabled = marketState.disabled`
        : `    const marketState = readMarketState(activeProfileDir);\n    const skillQuarantines = readSkillQuarantines(activeProfileDir);\n    const disabled = marketState.disabled;`,
      file,
    )
    const startNeedle = ext === 'ts'
      ? `  async function setPluginEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; reason?: string }> {\n    const dir = activeProfileDir\n    if (enabled) disabled.delete(name)`
      : `    async function setPluginEnabled(name, enabled) {\n        const dir = activeProfileDir;\n        if (enabled)\n            disabled.delete(name);`
    const startReplacement = ext === 'ts'
      ? `  async function setPluginEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; reason?: string; quarantined?: boolean }> {\n    const dir = activeProfileDir\n    const failuresBefore = enabled ? await captureSkillFailures(skillsLookup) : new Map()\n    if (enabled) disabled.delete(name)`
      : `    async function setPluginEnabled(name, enabled) {\n        const dir = activeProfileDir;\n        const failuresBefore = enabled ? await captureSkillFailures(skillsLookup) : new Map();\n        if (enabled)\n            disabled.delete(name);`
    source = replaceOnce(source, startNeedle, startReplacement, file)
    const endNeedle = ext === 'ts'
      ? `    writeMarketState(dir, { disabled, groups, groupOrder })\n    return { ok, reason }\n  }`
      : `        writeMarketState(dir, { disabled, groups, groupOrder });\n        return { ok, reason };\n    }`
    const endReplacement = ext === 'ts'
      ? `    if (enabled && ok) {\n      const failures = addedSkillFailures(failuresBefore, await captureSkillFailures(skillsLookup))\n      if (failures.length > 0) {\n        disabled.add(name)\n        await hotUnmount(name) || await themes.setEntryDisabled(name, true)\n        setSkillQuarantine(dir, skillQuarantines, name, failures)\n        writeMarketState(dir, { disabled, groups, groupOrder })\n        logEvent('warn', 'skill-quarantine', \`${'${name}'}: ${'${failures.map(failure => failure.message).join("; ")}'}\`)\n        return { ok: false, quarantined: true, reason: \`插件返回了无效的 Skill 元数据，已自动隔离；对话可继续使用。 / The plugin returned invalid Skill metadata and was quarantined; conversations can continue. ${'${failures[0].message}'}\` }\n      }\n      clearSkillQuarantine(dir, skillQuarantines, name)\n    }\n    writeMarketState(dir, { disabled, groups, groupOrder })\n    return { ok, reason }\n  }`
      : `        if (enabled && ok) {\n            const failures = addedSkillFailures(failuresBefore, await captureSkillFailures(skillsLookup));\n            if (failures.length > 0) {\n                disabled.add(name);\n                await hotUnmount(name) || await themes.setEntryDisabled(name, true);\n                setSkillQuarantine(dir, skillQuarantines, name, failures);\n                writeMarketState(dir, { disabled, groups, groupOrder });\n                logEvent('warn', 'skill-quarantine', \`${'${name}'}: ${'${failures.map(failure => failure.message).join("; ")}'}\`);\n                return { ok: false, quarantined: true, reason: \`插件返回了无效的 Skill 元数据，已自动隔离；对话可继续使用。 / The plugin returned invalid Skill metadata and was quarantined; conversations can continue. ${'${failures[0].message}'}\` };\n            }\n            clearSkillQuarantine(dir, skillQuarantines, name);\n        }\n        writeMarketState(dir, { disabled, groups, groupOrder });\n        return { ok, reason };\n    }`
    source = replaceOnce(source, endNeedle, endReplacement, file)
    source = replaceOnce(
      source,
      ext === 'ts' ? `          diagnostics,\n          live: listHotMounts(),` : `                    diagnostics,\n                    live: listHotMounts(),`,
      ext === 'ts' ? `          diagnostics,\n          skillQuarantines,\n          live: listHotMounts(),` : `                    diagnostics,\n                    skillQuarantines,\n                    live: listHotMounts(),`,
      file,
    )
    source = source.replace(
      ext === 'ts' ? `activation[name] = verifyActivation(config.profile, name, live, activeProfileDir,\n            disabled.has(name) || patchFlags.disabled.includes(name))` : `activation[name] = verifyActivation(config.profile, name, live, activeProfileDir,\n                    disabled.has(name) || patchFlags.disabled.includes(name));`,
      ext === 'ts'
        ? `activation[name] = skillQuarantines[name] === undefined\n            ? verifyActivation(config.profile, name, live, activeProfileDir, disabled.has(name) || patchFlags.disabled.includes(name))\n            : { state: 'broken', hot: false, reasons: skillQuarantines[name].failures.map((failure: { message: string }) => failure.message) }`
        : `activation[name] = skillQuarantines[name] === undefined\n                    ? verifyActivation(config.profile, name, live, activeProfileDir, disabled.has(name) || patchFlags.disabled.includes(name))\n                    : { state: 'broken', hot: false, reasons: skillQuarantines[name].failures.map((failure) => failure.message) };`,
    )
    source = source.replaceAll(
      ext === 'ts' ? `const live = entry.category === 'theme'\n                    ? await themes.activateTheme(name)\n                    : (await hotMount(host, activeProfileDir, name)).ok` : `const live = entry.category === 'theme'\n                                    ? await themes.activateTheme(name)\n                                    : (await hotMount(host, activeProfileDir, name)).ok;`,
      ext === 'ts'
        ? `const live = entry.category === 'theme'\n                    ? await themes.activateTheme(name)\n                    : (await setPluginEnabled(name, true)).ok`
        : `const live = entry.category === 'theme'\n                                    ? await themes.activateTheme(name)\n                                    : (await setPluginEnabled(name, true)).ok;`,
    )
    source = source.replace(
      ext === 'ts' ? `const result = await setPluginEnabled(name, enabled)\n            ok = result.ok\n            reason = result.reason` : `const result = await setPluginEnabled(name, enabled);\n                    ok = result.ok;\n                    reason = result.reason;`,
      ext === 'ts'
        ? `const result = await setPluginEnabled(name, enabled)\n            ok = result.ok\n            reason = result.reason\n            if (result.quarantined === true) enabled = false`
        : `const result = await setPluginEnabled(name, enabled);\n                    ok = result.ok;\n                    reason = result.reason;\n                    if (result.quarantined === true)\n                        enabled = false;`,
    )
    source = source.replace(ext === 'ts' ? `          const enabled = body.enabled === true` : `                const enabled = body.enabled === true;`, ext === 'ts' ? `          let enabled = body.enabled === true` : `                let enabled = body.enabled === true;`)
    writeFileSync(file, source)
  }
}

function completeSkillHealthPatch(marketDir) {
  const routeFiles = [join(marketDir, 'lib', 'routes.js'), join(marketDir, 'src', 'routes.ts')]
  for (const file of routeFiles) {
    if (!existsSync(file)) continue
    let source = readFileSync(file, 'utf8')
    const ts = file.endsWith('.ts')
    if (!source.includes('activation[name] = skillQuarantines[name] === undefined')) {
      const needle = ts
        ? `activation[name] = verifyActivation(config.profile, name, live, activeProfileDir,\n            disabled.has(name) || patchFlags.disabled.includes(name))`
        : `activation[name] = verifyActivation(config.profile, name, live, activeProfileDir, disabled.has(name) || patchFlags.disabled.includes(name));`
      const replacement = ts
        ? `activation[name] = skillQuarantines[name] === undefined\n            ? verifyActivation(config.profile, name, live, activeProfileDir, disabled.has(name) || patchFlags.disabled.includes(name))\n            : { state: 'broken', hot: false, reasons: skillQuarantines[name].failures.map((failure: { message: string }) => failure.message) }`
        : `activation[name] = skillQuarantines[name] === undefined\n                        ? verifyActivation(config.profile, name, live, activeProfileDir, disabled.has(name) || patchFlags.disabled.includes(name))\n                        : { state: 'broken', hot: false, reasons: skillQuarantines[name].failures.map((failure) => failure.message) };`
      source = replaceOnce(source, needle, replacement, file)
    }
    if (!source.includes('if (result.quarantined === true)')) {
      const needle = ts
        ? `const result = await setPluginEnabled(name, enabled)\n            ok = result.ok\n            reason = result.reason`
        : `const result = await setPluginEnabled(name, enabled);\n                        ok = result.ok;\n                        reason = result.reason;`
      const replacement = ts
        ? `${needle}\n            if (result.quarantined === true) enabled = false`
        : `${needle}\n                        if (result.quarantined === true)\n                            enabled = false;`
      source = replaceOnce(source, needle, replacement, file)
    }
    if (source.includes('(await hotMount(host, activeProfileDir, name)).ok')) {
      source = source.replaceAll('(await hotMount(host, activeProfileDir, name)).ok', '(await setPluginEnabled(name, true)).ok')
    }
    const directActivation = ts
      ? `activation[name] = verifyActivation(config.profile, name, live, activeProfileDir, disabled.has(name))`
      : `activation[name] = verifyActivation(config.profile, name, live, activeProfileDir, disabled.has(name));`
    const quarantinedActivation = ts
      ? `activation[name] = skillQuarantines[name] === undefined\n                    ? verifyActivation(config.profile, name, live, activeProfileDir, disabled.has(name))\n                    : { state: 'broken', hot: false, reasons: skillQuarantines[name].failures.map((failure: { message: string }) => failure.message) }`
      : `activation[name] = skillQuarantines[name] === undefined\n                                        ? verifyActivation(config.profile, name, live, activeProfileDir, disabled.has(name))\n                                        : { state: 'broken', hot: false, reasons: skillQuarantines[name].failures.map((failure) => failure.message) };`
    source = source.replaceAll(directActivation, quarantinedActivation)
    if (!source.includes('let quarantined = false')) {
      source = source.replace(
        ts ? `          let ok: boolean\n          let reason: string | undefined` : `                    let ok;\n                    let reason;`,
        ts ? `          let ok: boolean\n          let reason: string | undefined\n          let quarantined = false` : `                    let ok;\n                    let reason;\n                    let quarantined = false;`,
      )
      source = source.replace(
        ts ? `            reason = result.reason\n            if (result.quarantined === true) enabled = false` : `                        reason = result.reason;\n                        if (result.quarantined === true)\n                            enabled = false;`,
        ts ? `            reason = result.reason\n            quarantined = result.quarantined === true\n            if (quarantined) enabled = false` : `                        reason = result.reason;\n                        quarantined = result.quarantined === true;\n                        if (quarantined)\n                            enabled = false;`,
      )
      source = source.replace(
        ts ? `            reason,\n            patchRows,` : `                        reason,\n                        patchRows,`,
        ts ? `            reason,\n            quarantined,\n            patchRows,` : `                        reason,\n                        quarantined,\n                        patchRows,`,
      )
    }
    writeFileSync(file, source)
  }
}

function patchSkillHealthClient(marketDir) {
  const sourceFile = join(marketDir, 'src', 'client', 'MarketSection.tsx')
  if (existsSync(sourceFile)) {
    let source = readFileSync(sourceFile, 'utf8')
    source = source.replace(
      `                                  {off\n                                    ? (`,
      `                                  {off && act?.state !== 'broken'\n                                    ? (`,
    )
    source = source.replace(
      `          setInstallError(text(body.reason) || text(body.error) || t('toggleFail'))\n          // The durable state`,
      `          setInstallError(text(body.reason) || text(body.error) || t('toggleFail'))\n          if (body.quarantined === true) refreshInstalled()\n          // The durable state`,
    )
    writeFileSync(sourceFile, source)
  }
  const bundleFile = join(marketDir, 'client', 'client.js')
  if (existsSync(bundleFile)) {
    let source = readFileSync(bundleFile, 'utf8')
    source = source.replace(
      `off ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {`,
      `off && act?.state !== "broken" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {`,
    )
    source = source.replace(
      `setInstallError(text(body.reason) || text(body.error) || t("toggleFail"));\n\t\t\t\t\t\tif (body.restart === true)`,
      `setInstallError(text(body.reason) || text(body.error) || t("toggleFail"));\n\t\t\t\t\t\tif (body.quarantined === true) refreshInstalled();\n\t\t\t\t\t\tif (body.restart === true)`,
    )
    writeFileSync(bundleFile, source)
  }
}

/**
 * Patch the published dshmarket bundle with Desktop-only behavior:
 * - retry one failed package operation without inherited proxy variables;
 * - keep the market settings section above the desktop remote-access section.
 * The upstream package currently ships compiled artifacts in the runtime
 * bundle, so this is intentionally applied after every npm acquisition rather
 * than maintaining a forked package tree.
 */
export function applyDshmarketDesktopPatch(marketDir) {
  const file = join(marketDir, 'lib', 'dsh-cli.js')
  if (!existsSync(file)) throw new Error(`dshmarket desktop patch missing ${file}`)
  let source = readFileSync(file, 'utf8')
  if (source.includes(PATCH_MARKER)) {
    patchMarketSettingsOrder(marketDir)
    patchPersistentDiagnostics(marketDir)
    patchCancelledInstallRollback(marketDir)
    patchSkillHealth(marketDir)
    completeSkillHealthPatch(marketDir)
    patchSkillHealthClient(marketDir)
    patchManagedArtifactCleanup(marketDir)
    return
  }

  source = replaceOnce(
    source,
    "import { pluginArgsFor } from './pnpm-compat.js';\nimport { profileDir } from './profile.js';",
    "import { isFetchTimeoutFailure, isTransientPnpmFailure, pluginArgsFor } from './pnpm-compat.js';\nimport { profileDir } from './profile.js';\nimport { configuredProxy } from './net.js';",
    file,
  )
  source = replaceOnce(
    source,
    'const INSTALL_TIMEOUT_MS = Number(process.env.DSH_MARKET_INSTALL_TIMEOUT_MS) || 15 * 60 * 1000;',
    `const INSTALL_TIMEOUT_MS = Number(process.env.DSH_MARKET_INSTALL_TIMEOUT_MS) || 15 * 60 * 1000;
// ${PATCH_MARKER}: retry one failed add/install without inherited proxy variables.
const PROXY_ENV_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'npm_config_proxy', 'npm_config_https_proxy'];
function startWithoutProxy(start) {
    const saved = new Map();
    for (const key of PROXY_ENV_KEYS) { saved.set(key, process.env[key]); delete process.env[key]; }
    try { return start(); }
    finally {
        for (const key of PROXY_ENV_KEYS) {
            const value = saved.get(key);
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
}
function shouldRetryWithoutProxy(args, result, proxy) {
    if (proxy === null || result.cancelled || result.exitCode === 0 || result.timedOut) return false;
    if (args[0] !== 'add' && args[0] !== 'install') return false;
    const output = \`${'${result.stdout}'}\\n${'${result.stderr}'}\`;
    return isFetchTimeoutFailure(output) || isTransientPnpmFailure(output);
}`,
    file,
  )
  source = replaceOnce(source, '    const runPlugin = async (_profile, pluginArgs) => {', '    const runPluginAttempt = async (pluginArgs, withoutProxy) => {', file)
  source = replaceOnce(
    source,
    '            handle = service.runPlugin(prepared.args, invokingDir, abort.signal);',
    '            handle = withoutProxy ? startWithoutProxy(() => service.runPlugin(prepared.args, invokingDir, abort.signal)) : service.runPlugin(prepared.args, invokingDir, abort.signal);',
    file,
  )
  source = replaceOnce(
    source,
    '        return done;\n    };\n    const cancelOwned = (userCancelled) => {',
    `        return done;
    };
    const runPlugin = async (_profile, pluginArgs) => {
        const proxy = configuredProxy();
        const first = await runPluginAttempt(pluginArgs, false);
        if (!shouldRetryWithoutProxy(pluginArgs, first, proxy)) return first;
        logEvent('warn', 'install', \`proxy ${'${proxy}'} failed with a transient network error; retrying this package operation once without proxy\`);
        return await runPluginAttempt(pluginArgs, true);
    };
    const cancelOwned = (userCancelled) => {`,
    file,
  )
  writeFileSync(file, source)
  patchMarketSettingsOrder(marketDir)
  patchPersistentDiagnostics(marketDir)
  patchCancelledInstallRollback(marketDir)
  patchSkillHealth(marketDir)
  completeSkillHealthPatch(marketDir)
  patchSkillHealthClient(marketDir)
  patchManagedArtifactCleanup(marketDir)
}
