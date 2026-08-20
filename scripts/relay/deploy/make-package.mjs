// Build the dsh-desktop-relay deployment package for the JD Cloud server.
//
// Stages everything the server needs (relay sources, ws dependency, install
// script) into scripts/relay/.deploy/dsh-relay/. Upload that directory to the
// server any way you like (scp, WinSCP, 宝塔面板), then run:
//
//   sudo bash install.sh remote.example.com
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.deploy', 'dsh-relay')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

for (const entry of ['index.js', 'agent-demo.mjs', 'package.json']) {
  cpSync(join(root, entry), join(out, entry))
}
cpSync(join(root, 'lib'), join(out, 'lib'), { recursive: true })
cpSync(join(root, 'node_modules', 'ws'), join(out, 'node_modules', 'ws'), { recursive: true })
cpSync(join(root, 'deploy', 'install.sh'), join(out, 'install.sh'))

function sum(dir) {
  let total = 0
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    total += stat.isDirectory() ? sum(path) : stat.size
  }
  return total
}

console.log(`deployment package staged at ${out} (${(sum(out) / 1024).toFixed(0)} KiB)`)
console.log('upload it to the server, then run: sudo bash install.sh <你的域名>')
