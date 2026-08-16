// Assembles the zero-dependency runtime bundle:
//   runtime/node/        portable Node.js (no install)
//   runtime/dsh/         @deepseek-ai/dsh installed + locked
//   runtime/dsh/node_modules/dsh-desktop-bridge   the shell↔DSH bridge plugin
//
// Usage: node scripts/fetch-runtime.mjs [dsh-version]   (default 0.1.0-rc.6)
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const runtimeDir = path.join(root, 'runtime');
const nodeDir = path.join(runtimeDir, 'node');
const dshDir = path.join(runtimeDir, 'dsh');

const NODE_VERSION = 'v24.15.0';
const DSH_VERSION = process.argv[2] ?? '0.1.0-rc.6';

mkdirSync(runtimeDir, { recursive: true });

async function download(url, dest) {
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`download failed ${url}: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(dest, buf);
  console.log(`downloaded ${buf.length} bytes -> ${dest}`);
}

// ---------------------------------------------------------------- 1. Node
const nodeExe = path.join(nodeDir, 'node.exe');
if (!existsSync(nodeExe)) {
  console.log(`[1/3] fetching portable Node ${NODE_VERSION} ...`);
  const zip = path.join(runtimeDir, `node-${NODE_VERSION}-win-x64.zip`);
  await download(
    `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`,
    zip,
  );
  console.log('extracting ...');
  execFileSync('tar', ['-xf', zip, '-C', runtimeDir], { stdio: 'inherit', windowsHide: true });
  rmSync(zip);
  const extracted = path.join(runtimeDir, `node-${NODE_VERSION}-win-x64`);
  renameSync(extracted, nodeDir);
} else {
  console.log(`[1/3] Node ${NODE_VERSION} already present`);
}

// ---------------------------------------------------------------- 2. dsh
const dshPkg = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
const dshBin = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
if (!existsSync(dshBin)) {
  console.log(`[2/3] installing @deepseek-ai/dsh@${DSH_VERSION} ...`);
  const spec = DSH_VERSION === 'latest' ? '@deepseek-ai/dsh@latest' : `@deepseek-ai/dsh@${DSH_VERSION}`;
  // npm cache lives OUTSIDE runtime/ (kept out of the installer bundle)
  const cacheDir = path.join(root, '.npm-cache');
  mkdirSync(cacheDir, { recursive: true });
  // npm.cmd on Windows requires a shell; stdio inherit avoids pipe capture.
  const r = spawnSync(
    `npm install --prefix "${dshDir}" ${spec} --cache "${cacheDir}" --ignore-scripts --no-audit --no-fund`,
    { shell: true, stdio: 'inherit', cwd: root },
  );
  if (r.status !== 0) throw new Error(`npm install failed (exit ${r.status})`);
} else {
  console.log(`[2/3] dsh already installed`);
}

// ---------------------------------------------------------------- 3. bridge
console.log('[3/3] installing dsh-desktop-bridge into the dsh module tree ...');
const bridgeSrc = path.join(root, 'scripts', 'bridge');
const bridgeDst = path.join(dshDir, 'node_modules', 'dsh-desktop-bridge');
mkdirSync(bridgeDst, { recursive: true });
copyFileSync(path.join(bridgeSrc, 'package.json'), path.join(bridgeDst, 'package.json'));
copyFileSync(path.join(bridgeSrc, 'index.js'), path.join(bridgeDst, 'index.js'));
// canonical copy kept outside the dsh tree: re-applied after every dsh update
const bridgeStore = path.join(runtimeDir, 'bridge-src');
mkdirSync(bridgeStore, { recursive: true });
copyFileSync(path.join(bridgeSrc, 'package.json'), path.join(bridgeStore, 'package.json'));
copyFileSync(path.join(bridgeSrc, 'index.js'), path.join(bridgeStore, 'index.js'));

// ---------------------------------------------------------------- verify
console.log('verifying ...');
execFileSync(nodeExe, [dshBin, '--version'], { stdio: 'inherit', windowsHide: true });

const installed = JSON.parse(readFileSync(dshPkg, 'utf8')).version;
writeFileSync(
  path.join(runtimeDir, 'version.json'),
  JSON.stringify({ node: NODE_VERSION, dsh: installed }, null, 2) + '\n',
);
console.log(`runtime ready: node ${NODE_VERSION} + dsh ${installed}`);
