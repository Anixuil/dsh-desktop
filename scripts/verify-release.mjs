import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

function parseSemver(value) {
  const match = String(value || '').trim().replace(/^v/, '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) throw new Error(`非法 SemVer: ${value}`);
  return { raw: match[0], parts: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') ?? [] };
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return Math.sign(a.parts[index] - b.parts[index]);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const an = /^\d+$/.test(a.prerelease[index]);
    const bn = /^\d+$/.test(b.prerelease[index]);
    if (an && bn) return Math.sign(Number(a.prerelease[index]) - Number(b.prerelease[index]));
    if (an !== bn) return an ? -1 : 1;
    return a.prerelease[index].localeCompare(b.prerelease[index]);
  }
  return 0;
}

function projectVersions() {
  const packageVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const packageLock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const packageLockVersion = packageLock.packages?.['']?.version ?? packageLock.version;
  const tauriVersion = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
  const cargo = readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  return { packageVersion, packageLockVersion, tauriVersion, cargoVersion };
}

export function verifyLocalVersions(tag) {
  const versions = projectVersions();
  const unique = new Set(Object.values(versions));
  if (unique.size !== 1 || unique.has(undefined)) {
    throw new Error(`版本不一致: ${JSON.stringify(versions)}`);
  }
  const version = versions.packageVersion;
  parseSemver(version);
  if (tag && tag.replace(/^v/, '') !== version) throw new Error(`tag ${tag} 与项目版本 ${version} 不一致`);
  return version;
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-desktop-release-check' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}`);
  return response.json();
}

export async function verifyOnlineState(version) {
  const release = await getJson('https://api.github.com/repos/Anixuil/dsh-desktop/releases/latest');
  const online = String(release.tag_name || '').replace(/^v/, '');
  if (online === version) throw new Error(`线上最新版本仍为 ${version}，拒绝重复发布同一版本`);
  if (online && compareSemver(version, online) <= 0) throw new Error(`待发布版本 ${version} 不高于线上版本 ${online}`);
}

export async function verifyRuntime() {
  const runtimeFile = path.join(root, 'runtime', 'version.json');
  if (!existsSync(runtimeFile)) throw new Error('缺少 runtime/version.json');
  const embedded = JSON.parse(readFileSync(runtimeFile, 'utf8')).dsh;
  const latest = (await getJson('https://registry.npmjs.org/@deepseek-ai/dsh/latest')).version;
  if (compareSemver(embedded, latest) < 0) throw new Error(`内置 dsh ${embedded} 低于 npm latest ${latest}`);
  console.log(`内置 dsh ${embedded}，npm latest ${latest}`);
}

async function main() {
  const tagArg = process.argv.find((arg) => arg.startsWith('--tag='));
  const version = verifyLocalVersions(tagArg?.slice('--tag='.length) || process.env.GITHUB_REF_NAME || '');
  if (process.argv.includes('--online')) await verifyOnlineState(version);
  if (process.argv.includes('--runtime')) await verifyRuntime();
  console.log(`Release 版本校验通过: ${version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

export { compareSemver };
