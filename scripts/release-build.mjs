// Full Windows release build with step-level progress and timings.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const startedAt = Date.now();
const npmCli = process.env.npm_execpath;

function stamp() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function duration(ms) {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function readDshVersion() {
  const versionFile = path.join(root, 'runtime', 'version.json');
  if (!existsSync(versionFile)) return 'unavailable';
  try {
    return JSON.parse(readFileSync(versionFile, 'utf8')).dsh ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function run(index, name, command, args) {
  const stepStartedAt = Date.now();
  console.log(`\n[${stamp()}] [${index}/7] START ${name}`);
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  const elapsed = duration(Date.now() - stepStartedAt);
  if (result.error) {
    console.error(`[${stamp()}] [${index}/7] FAILED ${name} after ${elapsed}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[${stamp()}] [${index}/7] FAILED ${name} after ${elapsed} (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
  console.log(`[${stamp()}] [${index}/7] DONE ${name} in ${elapsed}`);
}

function runNpm(index, name, args) {
  if (npmCli) return run(index, name, process.execPath, [npmCli, ...args]);
  return run(index, name, 'npm', args);
}

function acquireReleaseLock() {
  const runtimeDir = path.join(root, 'runtime');
  const lockPath = path.join(runtimeDir, '.release-build.lock');
  mkdirSync(runtimeDir, { recursive: true });
  try {
    closeSync(openSync(lockPath, 'wx'));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const holder = readFileSync(lockPath, 'utf8').trim() || 'unknown process';
    throw new Error(`另一个 release:build 正在运行（${holder}）。请等待它完成后重试。`);
  }
  writeFileSync(lockPath, `pid=${process.pid}\nstartedAt=${new Date().toISOString()}\n`);
  return () => rmSync(lockPath, { force: true });
}

if (process.argv.includes('--help')) {
  console.log('Usage: npm run release:build');
  console.log('Runs dependency install, runtime refresh, tests, checks, archive, and NSIS build.');
  process.exit(0);
}

const releaseLock = acquireReleaseLock();
process.once('exit', releaseLock);

console.log(`[${stamp()}] Release build started in ${root}`);

runNpm(1, 'install JavaScript dependencies', ['install', '--cache', '.npm-cache']);
runNpm(2, 'fetch latest dsh runtime', ['run', 'fetch-runtime', '--', 'latest']);
console.log(`[${stamp()}] Embedded dsh version: ${readDshVersion()}`);
runNpm(3, 'run plugin and UI tests', ['run', 'test:plugins']);
run(4, 'run Rust tests', 'cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml']);
runNpm(5, 'compile Tauri without bundling', ['run', 'check']);
runNpm(6, 'archive embedded runtime', ['run', 'bundle-runtime']);
runNpm(7, 'build NSIS installer', ['run', 'build']);

const installerDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
console.log(`\n[${stamp()}] Release build complete in ${duration(Date.now() - startedAt)}`);
console.log(`Embedded dsh version: ${readDshVersion()}`);
console.log(`Installer directory: ${installerDir}`);
