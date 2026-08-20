// Sync rebuilt desktop plugin packages into the runtime tree.
//
// fetch-runtime.mjs does this as its [3/3] step during a full runtime fetch;
// after a plugin-only change (npm run build:plugins), run this instead of a
// full fetch: it rebuilds each plugin bundle and copies the package into
//   runtime/plugins-src/<name>          (canonical copy the shell redeploys)
//   runtime/dsh/node_modules/<name>     (CLI dsh web sharing the same tree)
// The shell's ensure_runtime_files then refreshes the profile on next boot.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const runtime = join(root, 'runtime')
const skipBuild = process.argv.includes('--no-build')
const plugins = [
  { name: 'dsh-desktop-bridge', dir: 'bridge' },
  { name: 'dsh-desktop-session-manager', dir: 'session-manager' },
  { name: 'dsh-desktop-change-history', dir: 'change-history' },
]

if (!existsSync(runtime)) {
  console.log('runtime tree absent (fetch-runtime not run yet) — nothing to sync')
  process.exit(0)
}

for (const { name, dir } of plugins) {
  const src = join(root, 'scripts', dir)
  if (!existsSync(join(src, 'package.json'))) {
    console.log(`skip ${name}: no package at ${src}`)
    continue
  }
  const build = join(src, 'build.mjs')
  if (!skipBuild && existsSync(build)) {
    console.log(`building ${name} ...`)
    execFileSync(process.execPath, [build], { stdio: 'inherit', windowsHide: true })
  }
  for (const target of [join(runtime, 'plugins-src', name), join(runtime, 'dsh', 'node_modules', name)]) {
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    cpSync(src, target, { recursive: true })
    console.log(`synced ${name} -> ${target}`)
  }
}
console.log('runtime plugin sync done — restart the app to redeploy into the profile')
