// Packs the stable runtime/node + runtime/dsh core into runtime-archive.tar.gz.
// The installer ships only this archive (~60MB, a few files) instead of the
// full extracted tree (~33k small files) — install/uninstall become fast;
// the app extracts it on first launch with a progress splash. Desktop plugin
// packages ship separately through runtime/plugins-src.
import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const runtimeDir = path.join(root, 'runtime');
const archive = path.join(runtimeDir, 'runtime-archive.tar.gz');
const manifestFile = path.join(runtimeDir, '.runtime-archive-manifest.json');
// These packages ship independently through runtime/plugins-src and are
// deployed into the shared DSH profile on boot. Keeping them out of the large
// core archive means ordinary desktop-plugin edits do not repack Node + dsh.
export const externalRuntimePlugins = [
  'dsh-desktop-bridge',
  'dsh-desktop-session-manager',
  'dsh-desktop-change-history',
  'dsh-desktop-file-upload',
  'dsh-desktop-conversation-navigator',
  'dsh-desktop-web-search',
  'dsh-vision-any',
  'dshmarket',
];
const excludedRuntimePaths = new Set(
  externalRuntimePlugins.map((name) => path.join('dsh', 'node_modules', name)),
);

function isExternalRuntimePath(relativePath) {
  for (const excluded of excludedRuntimePaths) {
    if (relativePath === excluded || relativePath.startsWith(`${excluded}${path.sep}`)) return true;
  }
  return false;
}

function collectEntries(baseDir, relativeDir, entries) {
  if (isExternalRuntimePath(relativeDir)) return;
  const absoluteDir = path.join(baseDir, relativeDir);
  entries.push({ type: 'directory', relativePath: relativeDir });
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      collectEntries(baseDir, relativePath, entries);
    } else if (entry.isSymbolicLink()) {
      entries.push({ type: 'symlink', relativePath });
    } else if (entry.isFile()) {
      entries.push({ type: 'file', relativePath });
    }
  }
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export async function computeRuntimeManifest(baseDir, previousManifest = null) {
  const entries = [];
  for (const relativeDir of ['node', 'dsh']) collectEntries(baseDir, relativeDir, entries);
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en'));

  const previousEntries = new Map(
    previousManifest?.version === 1
      ? previousManifest.entries.map((entry) => [entry.path, entry])
      : [],
  );
  const records = entries.map(({ type, relativePath }) => {
    const normalizedPath = relativePath.replaceAll(path.sep, '/');
    const absolutePath = path.join(baseDir, relativePath);
    if (type === 'file') {
      const stats = lstatSync(absolutePath, { bigint: true });
      const record = {
        type: 'file',
        path: normalizedPath,
        size: stats.size.toString(),
        mtimeNs: stats.mtimeNs.toString(),
        mode: stats.mode.toString(),
        hash: null,
        absolutePath,
      };
      const previous = previousEntries.get(normalizedPath);
      if (
        previous?.type === record.type
        && previous.size === record.size
        && previous.mode === record.mode
        && previous.mtimeNs === record.mtimeNs
        && typeof previous.hash === 'string'
      ) {
        record.hash = previous.hash;
      }
      return record;
    }
    if (type === 'symlink') {
      return { type: 'symlink', path: normalizedPath, target: readlinkSync(absolutePath) };
    }
    return { type: 'directory', path: normalizedPath };
  });

  const unhashedFiles = records.filter((record) => record.type === 'file' && record.hash === null);
  const hashes = await mapWithConcurrency(unhashedFiles, 12, (record) => hashFile(record.absolutePath));
  for (let index = 0; index < unhashedFiles.length; index += 1) unhashedFiles[index].hash = hashes[index];

  const manifestEntries = records.map(({ absolutePath: _absolutePath, ...record }) => record);
  const manifest = { version: 1, entries: manifestEntries };
  const contentRecords = manifestEntries.map(({ mtimeNs: _mtimeNs, ...record }) => record);
  const contentFingerprint = createHash('sha256')
    .update('content-v1-external-plugins\0')
    .update(JSON.stringify(contentRecords))
    .digest('hex');
  const unchanged = previousManifest?.contentFingerprint === contentFingerprint;
  return { manifest: { ...manifest, contentFingerprint }, unchanged, hashedFiles: unhashedFiles.length };
}

export async function computeRuntimeFingerprint(baseDir) {
  return (await computeRuntimeManifest(baseDir)).manifest.contentFingerprint;
}

export function runtimeArchiveArgs(targetArchive, baseDir = runtimeDir) {
  const excludes = externalRuntimePlugins.flatMap((name) => [
    '--exclude',
    `dsh/node_modules/${name}`,
  ]);
  return ['-czf', targetArchive, ...excludes, '-C', baseDir, 'node', 'dsh'];
}

export async function buildRuntimeArchive() {
  if (!existsSync(path.join(runtimeDir, 'node', 'node.exe'))) {
    throw new Error('runtime/node missing — run: node scripts/fetch-runtime.mjs first');
  }
  if (!existsSync(path.join(runtimeDir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    throw new Error('runtime/dsh missing — run: node scripts/fetch-runtime.mjs first');
  }

  console.log('checking runtime archive inputs ...');
  let previousManifest = null;
  if (existsSync(manifestFile)) {
    try {
      previousManifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    } catch {
      previousManifest = null;
    }
  }
  const runtimeState = await computeRuntimeManifest(runtimeDir, previousManifest);
  if (existsSync(archive) && runtimeState.unchanged) {
    writeFileSync(manifestFile, `${JSON.stringify(runtimeState.manifest)}\n`);
    console.log(`runtime archive unchanged — reusing ${archive}`);
    return { archive, cached: true, fingerprint: runtimeState.manifest.contentFingerprint };
  }

  const temporaryArchive = `${archive}.tmp-${process.pid}`;
  rmSync(temporaryArchive, { force: true });
  console.log('packing runtime archive ...');
  try {
    execFileSync('tar', runtimeArchiveArgs(temporaryArchive), {
      stdio: 'inherit',
      windowsHide: true,
    });
    rmSync(archive, { force: true });
    renameSync(temporaryArchive, archive);
    writeFileSync(manifestFile, `${JSON.stringify(runtimeState.manifest)}\n`);
  } finally {
    rmSync(temporaryArchive, { force: true });
  }
  console.log(`archive written: ${archive}`);
  return { archive, cached: false, fingerprint: runtimeState.manifest.contentFingerprint };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildRuntimeArchive().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
