// Assembles the zero-dependency runtime bundle:
//   runtime/node/         portable Node.js (no install)
//   runtime/dsh/          @deepseek-ai/dsh installed + locked
//   runtime/dsh/node_modules/<plugin>   desktop plugin packages (bridge,
//                          session-manager) + bundled dsh-vision-any,
//                          canonical copies in runtime/plugins-src
//
// Usage: node scripts/fetch-runtime.mjs [dsh-version]   (default 0.1.0-rc.6)
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const runtimeDir = path.join(root, 'runtime');
const nodeDir = path.join(runtimeDir, 'node');
const dshDir = path.join(runtimeDir, 'dsh');

const NODE_VERSION = 'v24.15.0';
const DSH_VERSION = process.argv[2] ?? '0.1.0-rc.6';

// Bundled third-party plugin (github.com/tianmingwan/dsh-vision-any).
// Pinned by commit so every build reproduces the same code; bump the pin
// (and the package version) together when adopting an upstream release.
// DSH_DESKTOP_VISION_TARBALL overrides the download with a local tarball
// (offline builds / CI).
const VISION_PLUGIN = {
  name: 'dsh-vision-any',
  repo: 'tianmingwan/dsh-vision-any',
  pin: '1c50ab0c71749755f9307e1ef43bc1f5f01dd8c0',
  version: '0.1.0',
  files: ['package.json', 'index.js', 'lib', 'cordis.patch.yml', 'README.md', 'README.en.md', 'assets', 'LICENSE'],
};

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

// ---------------------------------------------------------------- 3. plugins
console.log('[3/3] installing desktop plugin packages into the dsh module tree ...');
// Client halves ship as one prebuilt bundle per package; each package's
// modular src/ is bundled by its own build.mjs (shared zero-dep bundler).
const desktopPlugins = [
  { name: 'dsh-desktop-bridge', dir: 'bridge' },
  { name: 'dsh-desktop-session-manager', dir: 'session-manager' },
];
const pluginStore = path.join(runtimeDir, 'plugins-src');
const copyTree = (src, dst) => {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTree(from, to);
    } else {
      copyFileSync(from, to);
    }
  }
};
for (const { name, dir } of desktopPlugins) {
  const src = path.join(root, 'scripts', dir);
  if (!existsSync(path.join(src, 'package.json'))) throw new Error(`plugin package missing: ${src}`);
  const build = path.join(src, 'build.mjs');
  if (existsSync(build)) {
    execFileSync(process.execPath, [build], { stdio: 'inherit', windowsHide: true });
  }
  for (const target of [path.join(dshDir, 'node_modules', name), path.join(pluginStore, name)]) {
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
  }
  copyTree(src, path.join(dshDir, 'node_modules', name));
  // canonical copies kept outside the dsh tree: re-applied after every dsh update
  copyTree(src, path.join(pluginStore, name));
}
// legacy canonical location is superseded by plugins-src (single source of truth)
rmSync(path.join(runtimeDir, 'bridge-src'), { recursive: true, force: true });

// ---------------------------------------------------------------- 4. vision
console.log('[4/4] fetching bundled vision plugin (dsh-vision-any) ...');
{
  const { name, pin, files } = VISION_PLUGIN;
  const pinMarker = path.join(pluginStore, name, '.pin');
  const pinned = existsSync(pinMarker) && readFileSync(pinMarker, 'utf8').trim() === pin;
  if (!pinned) {
    const override = process.env.DSH_DESKTOP_VISION_TARBALL;
    const zip = override ?? path.join(runtimeDir, 'dsh-vision-any.tgz');
    if (!override) {
      await download(
        `https://codeload.github.com/${VISION_PLUGIN.repo}/tar.gz/${pin}`,
        zip,
      );
    }
    console.log('extracting ...');
    const extractDir = path.join(runtimeDir, 'vision-extract');
    rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['-xzf', zip, '-C', extractDir], { stdio: 'inherit', windowsHide: true });
    if (!override) rmSync(zip);
    // codeload nests everything under <repo>-<sha>/ — locate the payload
    const top = readdirSync(extractDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (top.length !== 1) {
      throw new Error(`unexpected vision tarball layout: ${top.map((e) => e.name).join(', ')}`);
    }
    const payload = path.join(extractDir, top[0].name);
    const pkgJson = JSON.parse(readFileSync(path.join(payload, 'package.json'), 'utf8'));
    if (pkgJson.name !== name) {
      throw new Error(`vision tarball package name mismatch: ${pkgJson.name} != ${name}`);
    }
    const deployed = pkgJson.version ?? VISION_PLUGIN.version;
    // ship only the package's published file set (skip repo cruft)
    const missing = [];
    const copyEntry = (from, to) => {
      if (!existsSync(from)) return;
      const st = statSync(from);
      if (st.isDirectory()) {
        mkdirSync(to, { recursive: true });
        copyTree(from, to);
      } else {
        mkdirSync(path.dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
    };
    for (const target of [path.join(dshDir, 'node_modules', name), path.join(pluginStore, name)]) {
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
    }
    for (const entry of files) {
      const from = path.join(payload, entry);
      if (!existsSync(from)) {
        missing.push(entry);
        continue;
      }
      copyEntry(from, path.join(pluginStore, name, entry));
    }
    // pin marker + provenance, then mirror the plugin store into the dsh tree
    writeFileSync(pinMarker, `${pin}\n`);
    writeFileSync(
      path.join(pluginStore, name, '.source.json'),
      JSON.stringify(
        { repo: VISION_PLUGIN.repo, pin, version: deployed, files, missing },
        null,
        2,
      ) + '\n',
    );
    for (const entry of readdirSync(path.join(pluginStore, name))) {
      if (entry === '.pin' || entry === '.source.json') continue; // store markers stay canonical-only
      copyEntry(path.join(pluginStore, name, entry), path.join(dshDir, 'node_modules', name, entry));
    }
    rmSync(extractDir, { recursive: true, force: true });
    if (missing.length > 0) throw new Error(`vision tarball missing published files: ${missing.join(', ')}`);
    console.log(`vision plugin ${name}@${deployed} deployed (pin ${pin.slice(0, 8)})`);
  } else {
    console.log(`[4/4] vision plugin ${name} already at pin ${pin.slice(0, 8)}`);
  }
}

// ---------------------------------------------------------------- verify
console.log('verifying ...');
execFileSync(nodeExe, [dshBin, '--version'], { stdio: 'inherit', windowsHide: true });

const installed = JSON.parse(readFileSync(dshPkg, 'utf8')).version;
writeFileSync(
  path.join(runtimeDir, 'version.json'),
  JSON.stringify(
    {
      node: NODE_VERSION,
      dsh: installed,
      vision: { package: VISION_PLUGIN.name, version: VISION_PLUGIN.version, pin: VISION_PLUGIN.pin },
    },
    null,
    2,
  ) + '\n',
);
console.log(`runtime ready: node ${NODE_VERSION} + dsh ${installed} + vision ${VISION_PLUGIN.name}@${VISION_PLUGIN.version}`);
