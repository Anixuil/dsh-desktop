// Local Tauri build entrypoint. Production CI invokes tauri-action directly
// with updater signing secrets; local builds should still be able to produce a
// regular NSIS setup.exe when those secrets are intentionally unavailable.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const tauriCli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const args = ['build', ...process.argv.slice(2)]
const hasExplicitConfig = args.some((arg) => arg === '--config' || arg.startsWith('--config='))
const hasSigningKeyContent = typeof process.env.TAURI_SIGNING_PRIVATE_KEY === 'string'
  && process.env.TAURI_SIGNING_PRIVATE_KEY.trim() !== ''
const signingKeyPath = typeof process.env.TAURI_SIGNING_PRIVATE_KEY_PATH === 'string'
  ? process.env.TAURI_SIGNING_PRIVATE_KEY_PATH.trim()
  : ''
const hasSigningKeyPath = signingKeyPath !== ''
const hasSigningKey = hasSigningKeyContent || hasSigningKeyPath
let buildEnv = process.env

if (!existsSync(tauriCli)) {
  throw new Error('Tauri CLI 未安装；请先运行 npm install --cache .npm-cache')
}

// Tauri build 2.11 still consumes key content from
// TAURI_SIGNING_PRIVATE_KEY. Accept its documented *_PATH companion here and
// inject the file content only into the child process without logging it.
if (!hasSigningKeyContent && hasSigningKeyPath) {
  const resolvedSigningKeyPath = path.resolve(signingKeyPath)
  if (!existsSync(resolvedSigningKeyPath)) {
    throw new Error(`Updater 私钥文件不存在: ${resolvedSigningKeyPath}`)
  }
  const { TAURI_SIGNING_PRIVATE_KEY_PATH: _signingKeyPath, ...envWithoutSigningKeyPath } = process.env
  buildEnv = {
    ...envWithoutSigningKeyPath,
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(resolvedSigningKeyPath, 'utf8'),
  }
}

if (!hasSigningKey && !hasExplicitConfig) {
  args.push('--config', 'src-tauri/tauri.local.conf.json')
  console.log('未配置 TAURI_SIGNING_PRIVATE_KEY：生成普通 NSIS 安装包，跳过 updater artifact 签名')
}

const informationalOnly = args.some((arg) => ['--help', '-h', '--version', '-V'].includes(arg))
if (hasSigningKey && !informationalOnly) {
  const probeDir = mkdtempSync(path.join(tmpdir(), 'dsh-updater-signing-'))
  const probeFile = path.join(probeDir, 'probe.txt')
  try {
    writeFileSync(probeFile, 'dsh updater signing preflight\n')
    const probe = spawnSync(process.execPath, [tauriCli, 'signer', 'sign', probeFile], {
      cwd: root,
      env: buildEnv,
      encoding: 'utf8',
      windowsHide: true,
    })
    if (probe.error) throw probe.error
    if (probe.status !== 0) {
      const detail = String(probe.stderr || probe.stdout || '').trim()
      throw new Error(`Updater 私钥签名预检失败${detail ? `：${detail}` : ''}`)
    }
    console.log('Updater 私钥签名预检通过')
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}

const result = spawnSync(process.execPath, [tauriCli, ...args], {
  cwd: root,
  env: buildEnv,
  stdio: 'inherit',
  windowsHide: true,
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
