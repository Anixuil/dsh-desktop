import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareSemver, verifyLocalVersions } from './verify-release.mjs';

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

console.log('release configuration tests passed');
