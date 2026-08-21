// Full Windows release build with step-level progress and timings.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const startedAt = Date.now();
const npmCli = process.env.npm_execpath;
const developmentRelease = process.argv.includes('--dev');

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

function run(index, total, name, command, args) {
  const stepStartedAt = Date.now();
  console.log(`\n[${stamp()}] [${index}/${total}] START ${name}`);
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  const elapsed = duration(Date.now() - stepStartedAt);
  if (result.error) {
    console.error(`[${stamp()}] [${index}/${total}] FAILED ${name} after ${elapsed}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[${stamp()}] [${index}/${total}] FAILED ${name} after ${elapsed} (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
  console.log(`[${stamp()}] [${index}/${total}] DONE ${name} in ${elapsed}`);
}

function runNpm(index, total, name, args) {
  if (npmCli) return run(index, total, name, process.execPath, [npmCli, ...args]);
  return run(index, total, name, 'npm', args);
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
    throw new Error(`另一个 release 构建正在运行（${holder}）。请等待它完成后重试。`);
  }
  writeFileSync(lockPath, `pid=${process.pid}\nstartedAt=${new Date().toISOString()}\n`);
  return () => rmSync(lockPath, { force: true });
}

if (process.argv.includes('--help')) {
  console.log('Usage: npm run release:build | npm run release-dev');
  console.log('release:build refreshes to the latest dsh runtime before building.');
  console.log('release-dev keeps the checked-out runtime and rebuilds all local release artifacts.');
  process.exit(0);
}

const releaseLock = acquireReleaseLock();
process.once('exit', releaseLock);

const totalSteps = 8;
console.log(`[${stamp()}] ${developmentRelease ? 'Development release' : 'Release'} build started in ${root}`);

runNpm(1, totalSteps, 'install JavaScript dependencies', ['install', '--cache', '.npm-cache']);
let step = 2;
if (developmentRelease) {
  run(step, totalSteps, 'verify embedded runtime', process.execPath, [
    '-e',
    "const { existsSync } = require('node:fs'); const { join } = require('node:path'); const root = process.cwd(); const required = [join(root, 'runtime', 'node', 'node.exe'), join(root, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]; if (!required.every(existsSync)) { console.error('embedded runtime is missing — run: npm run fetch-runtime -- latest'); process.exit(1); }",
  ]);
} else {
  runNpm(step, totalSteps, 'fetch latest dsh runtime', ['run', 'fetch-runtime', '--', 'latest']);
}
console.log(`[${stamp()}] Embedded dsh version: ${readDshVersion()}`);
step += 1;
runNpm(step++, totalSteps, 'rebuild embedded plugins', ['run', 'build:plugins']);
runNpm(step++, totalSteps, 'run plugin and UI tests', ['run', 'test:plugins']);
run(step++, totalSteps, 'run Rust tests', 'cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml']);
runNpm(step++, totalSteps, 'compile Tauri without bundling', ['run', 'check']);
runNpm(step++, totalSteps, 'archive embedded runtime', ['run', 'bundle-runtime']);
runNpm(step, totalSteps, 'build NSIS installer', ['run', 'build']);

const installerDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
console.log(`\n[${stamp()}] Release build complete in ${duration(Date.now() - startedAt)}`);
console.log(`Embedded dsh version: ${readDshVersion()}`);
console.log(`Installer directory: ${installerDir}`);
