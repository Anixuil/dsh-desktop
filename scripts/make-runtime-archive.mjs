// Packs runtime/node + runtime/dsh into a single runtime-archive.tar.gz.
// The installer ships only this archive (~60MB, a few files) instead of the
// full extracted tree (~33k small files) — install/uninstall become fast;
// the app extracts it on first launch with a progress splash.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const runtimeDir = path.join(root, 'runtime');
const archive = path.join(runtimeDir, 'runtime-archive.tar.gz');

if (!existsSync(path.join(runtimeDir, 'node', 'node.exe'))) {
  console.error('runtime/node missing — run: node scripts/fetch-runtime.mjs first');
  process.exit(1);
}
if (!existsSync(path.join(runtimeDir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
  console.error('runtime/dsh missing — run: node scripts/fetch-runtime.mjs first');
  process.exit(1);
}

rmSync(archive, { force: true });
console.log('packing runtime archive ...');
execFileSync('tar', ['-czf', archive, '-C', runtimeDir, 'node', 'dsh'], {
  stdio: 'inherit',
  windowsHide: true,
});
console.log(`archive written: ${archive}`);
