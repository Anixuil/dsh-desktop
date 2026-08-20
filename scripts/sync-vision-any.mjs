// Sync the desktop overlay of the bundled dsh-vision-any plugin into the
// runtime tree.
//
// The third-party plugin package is fetched by fetch-runtime.mjs from the
// pinned upstream commit into runtime/plugins-src/dsh-vision-any; the
// desktop-local half (web client sources + host patches) lives here in
// scripts/vision-any/ and is overlaid on top of it:
//   src/*          -> <pkg>/src/*        (modular client sources)
//   client.js      -> <pkg>/client.js    (bundle built by scripts/vision-any/build.mjs)
//   build.mjs      -> <pkg>/build.mjs    (in-tree rebuild entry)
//   overlay/*      -> <pkg>/...          (full-file host patches: index.js, lib/routes.js)
// The patched package is then mirrored into runtime/dsh/node_modules/dsh-vision-any
// (CLI dsh web sharing the same tree). The shell's ensure_runtime_files
// redeploys plugins-src into the profile on next boot.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const runtime = join(root, 'runtime')
const overlay = join(root, 'scripts', 'vision-any')
const skipBuild = process.argv.includes('--no-build')

const CLIENT_FILES = ['client.js', 'build.mjs']
const OVERLAY_FILES = ['index.js', 'lib/routes.js']

const pkgDir = join(runtime, 'plugins-src', 'dsh-vision-any')
if (!existsSync(join(pkgDir, 'package.json'))) {
  console.log('vision plugin absent from runtime/plugins-src (fetch-runtime not run yet) — nothing to sync')
  process.exit(0)
}

if (!skipBuild) {
  console.log('building dsh-vision-any client bundle ...')
  execFileSync(process.execPath, [join(overlay, 'build.mjs')], { stdio: 'inherit', windowsHide: true })
}

const copyFile = (from, to) => {
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { force: true })
}
const copyTree = (src, dst) => {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name)
    const to = join(dst, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true })
      copyTree(from, to)
    } else {
      cpSync(from, to, { force: true })
    }
  }
}

// Client half: overlay src/ then the built bundle + in-tree build entry.
copyTree(join(overlay, 'src'), join(pkgDir, 'src'))
for (const file of CLIENT_FILES) copyFile(join(overlay, file), join(pkgDir, file))

// Host patches: full-file replacements of the fetched upstream files.
for (const file of OVERLAY_FILES) copyFile(join(overlay, 'overlay', file), join(pkgDir, file))

// Mirror the patched package into the dsh module tree. Store markers
// (.pin/.source.json) stay canonical-only, matching fetch-runtime.mjs.
const mirror = join(runtime, 'dsh', 'node_modules', 'dsh-vision-any')
if (existsSync(join(runtime, 'dsh', 'node_modules'))) {
  rmSync(mirror, { recursive: true, force: true })
  mkdirSync(mirror, { recursive: true })
  const copyEntry = (from, to) => {
    if (statSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true })
      copyTree(from, to)
    } else {
      mkdirSync(dirname(to), { recursive: true })
      cpSync(from, to, { force: true })
    }
  }
  for (const entry of readdirSync(pkgDir)) {
    if (entry === '.pin' || entry === '.source.json') continue
    copyEntry(join(pkgDir, entry), join(mirror, entry))
  }
} else {
  console.log('runtime/dsh tree absent — skipped mirror')
}

console.log('vision overlay sync done — restart the app to redeploy into the profile')
