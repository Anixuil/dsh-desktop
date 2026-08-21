import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareSemver, verifyLocalVersions } from './verify-release.mjs';
import {
  computeRuntimeFingerprint,
  computeRuntimeManifest,
  externalRuntimePlugins,
  runtimeArchiveArgs,
} from './make-runtime-archive.mjs';

assert.equal(verifyLocalVersions('v0.2.1'), '0.2.1');
assert.equal(compareSemver('0.2.1', '0.2.0'), 1);
assert.equal(compareSemver('0.2.1-beta.2', '0.2.1-beta.10'), -1);
assert.equal(compareSemver('0.2.1', '0.2.1-rc.1'), 1);

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY:/);
assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD:/);
assert.match(workflow, /tags:\s*\[?['"]v\*['"]?\]?/);
assert.match(workflow, /updaterJsonPreferNsis:\s*true/);
assert.match(workflow, /windows-x86_64/);

const tauri = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
assert.deepEqual(tauri.plugins.updater.endpoints, [
  'https://github.com/Anixuil/dsh-desktop/releases/latest/download/latest.json',
]);
assert.match(tauri.plugins.updater.pubkey, /^[A-Za-z0-9+/]+=*$/);
assert.ok(tauri.plugins.updater.pubkey.length > 100, 'updater public key must not be a placeholder');
assert.equal(tauri.plugins.updater.windows.installMode, 'passive');

const fastTauri = JSON.parse(readFileSync(new URL('../src-tauri/tauri.fast.conf.json', import.meta.url), 'utf8'));
assert.equal(fastTauri.bundle.windows.nsis.compression, 'none');
assert.equal(fastTauri.bundle.createUpdaterArtifacts, false);

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.match(packageJson.scripts['release-dev:fast'], /--dev --fast/);

const releaseBuild = readFileSync(new URL('./release-build.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(releaseBuild, /'compile Tauri without bundling'/);
assert.match(releaseBuild, /CARGO_PROFILE_RELEASE_LTO: 'thin'/);
assert.match(releaseBuild, /CARGO_TARGET_DIR: path\.join\(root, 'src-tauri', 'target-fast'\)/);
assert.match(releaseBuild, /dependenciesAreCurrent/);
assert.ok(runtimeArchiveArgs('fixture.tar.gz').includes('dsh/node_modules/dsh-desktop-bridge'));

const runtimeFixture = mkdtempSync(join(tmpdir(), 'dsh-runtime-fingerprint-'));
try {
  mkdirSync(join(runtimeFixture, 'node'), { recursive: true });
  mkdirSync(join(runtimeFixture, 'dsh', 'empty'), { recursive: true });
  const externalPlugin = externalRuntimePlugins[0];
  mkdirSync(join(runtimeFixture, 'dsh', 'node_modules', externalPlugin), { recursive: true });
  writeFileSync(join(runtimeFixture, 'node', 'node.exe'), 'node-a');
  writeFileSync(join(runtimeFixture, 'dsh', 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(runtimeFixture, 'dsh', 'node_modules', externalPlugin, 'index.js'), 'plugin-a');
  const firstFingerprint = await computeRuntimeFingerprint(runtimeFixture);
  assert.equal(await computeRuntimeFingerprint(runtimeFixture), firstFingerprint);
  writeFileSync(join(runtimeFixture, 'dsh', 'node_modules', externalPlugin, 'index.js'), 'plugin-longer');
  assert.equal(
    await computeRuntimeFingerprint(runtimeFixture),
    firstFingerprint,
    'external plugin edits must not invalidate the core runtime archive',
  );
  const initialManifest = await computeRuntimeManifest(runtimeFixture);
  const nodeFixture = join(runtimeFixture, 'node', 'node.exe');
  const future = new Date(Date.now() + 10_000);
  utimesSync(nodeFixture, future, future);
  const timestampOnlyChange = await computeRuntimeManifest(runtimeFixture, initialManifest.manifest);
  assert.equal(timestampOnlyChange.unchanged, true, 'mtime-only changes must reuse the core archive');
  assert.equal(timestampOnlyChange.hashedFiles, 1);
  writeFileSync(join(runtimeFixture, 'node', 'node.exe'), 'node-longer');
  assert.notEqual(await computeRuntimeFingerprint(runtimeFixture), firstFingerprint);

  const fixtureArchive = join(runtimeFixture, 'core.tar.gz');
  const packed = spawnSync('tar', runtimeArchiveArgs(fixtureArchive, runtimeFixture), {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(packed.status, 0, packed.stderr);
  const listed = spawnSync('tar', ['-tf', fixtureArchive], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(listed.status, 0, listed.stderr);
  const archiveEntries = listed.stdout.replaceAll('\\', '/');
  assert.match(archiveEntries, /dsh\/package\.json/);
  assert.doesNotMatch(archiveEntries, new RegExp(`dsh/node_modules/${externalPlugin}/`));
} finally {
  rmSync(runtimeFixture, { recursive: true, force: true });
}

console.log('release configuration tests passed');
