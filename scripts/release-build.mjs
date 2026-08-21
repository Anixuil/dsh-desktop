// Full Windows release build with step-level progress and timings.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const startedAt = Date.now();
const npmCli = process.env.npm_execpath;
const developmentRelease = process.argv.includes('--dev');
const fastRelease = process.argv.includes('--fast');
const forceInstall = process.argv.includes('--force-install');
const installStateFile = path.join(root, '.npm-cache', 'release-install-state.json');

if (fastRelease && !developmentRelease) {
  throw new Error('--fast 仅用于本地 development release，请使用 npm run release-dev:fast');
}

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

function run(index, total, name, command, args, options = {}) {
  const stepStartedAt = Date.now();
  console.log(`\n[${stamp()}] [${index}/${total}] START ${name}`);
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, ...options.env },
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

function runNpm(index, total, name, args, options) {
  if (npmCli) return run(index, total, name, process.execPath, [npmCli, ...args], options);
  return run(index, total, name, 'npm', args, options);
}

function dependencyFingerprint() {
  const hash = createHash('sha256');
  for (const file of ['package.json', 'package-lock.json']) hash.update(readFileSync(path.join(root, file)));
  return hash.digest('hex');
}

function dependenciesAreCurrent(fingerprint) {
  if (forceInstall || !existsSync(path.join(root, 'node_modules', '@tauri-apps', 'cli', 'package.json'))) return false;
  if (!existsSync(installStateFile)) return false;
  try {
    return JSON.parse(readFileSync(installStateFile, 'utf8')).fingerprint === fingerprint;
  } catch {
    return false;
  }
}

function ensureDependencies(index, total) {
  const fingerprint = dependencyFingerprint();
  if (dependenciesAreCurrent(fingerprint)) {
    console.log(`\n[${stamp()}] [${index}/${total}] SKIP JavaScript dependencies unchanged`);
    return;
  }
  runNpm(index, total, 'install JavaScript dependencies', [
    'install',
    '--cache',
    '.npm-cache',
    '--no-audit',
    '--no-fund',
  ]);
  mkdirSync(path.dirname(installStateFile), { recursive: true });
  writeFileSync(installStateFile, `${JSON.stringify({ fingerprint }, null, 2)}\n`);
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
  console.log('Usage: npm run release:build | npm run release-dev | npm run release-dev:fast');
  console.log('release:build refreshes to the latest dsh runtime before building.');
  console.log('release-dev keeps the checked-out runtime and rebuilds all local release artifacts.');
  console.log('release-dev:fast uses Thin LTO, parallel codegen, and an uncompressed NSIS test installer.');
  console.log('Pass --force-install to refresh JavaScript dependencies even when lock files are unchanged.');
  process.exit(0);
}

const releaseLock = acquireReleaseLock();
process.once('exit', releaseLock);

const totalSteps = 7;
const releaseName = fastRelease ? 'Fast development release' : developmentRelease ? 'Development release' : 'Release';
console.log(`[${stamp()}] ${releaseName} build started in ${root}`);

ensureDependencies(1, totalSteps);
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
runNpm(step++, totalSteps, 'archive embedded runtime', ['run', 'bundle-runtime']);
const buildArgs = fastRelease
  ? ['run', 'build', '--', '--config', 'src-tauri/tauri.fast.conf.json']
  : ['run', 'build'];
const buildEnv = fastRelease
  ? {
      CARGO_PROFILE_RELEASE_LTO: 'thin',
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '8',
      CARGO_TARGET_DIR: path.join(root, 'src-tauri', 'target-fast'),
    }
  : undefined;
runNpm(step, totalSteps, fastRelease ? 'build fast NSIS installer' : 'build NSIS installer', buildArgs, {
  env: buildEnv,
});

const cargoTargetDir = fastRelease
  ? path.join(root, 'src-tauri', 'target-fast')
  : path.join(root, 'src-tauri', 'target');
const installerDir = path.join(cargoTargetDir, 'release', 'bundle', 'nsis');
console.log(`\n[${stamp()}] Release build complete in ${duration(Date.now() - startedAt)}`);
console.log(`Embedded dsh version: ${readDshVersion()}`);
console.log(`Installer directory: ${installerDir}`);
