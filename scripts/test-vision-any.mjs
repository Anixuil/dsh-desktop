// dsh-vision-any smoke test: covers the desktop-local image preview seams.
//
//   * scripts/vision-any overlay stays authoritative: its client sources,
//     host patches and built bundle match the fetched package in
//     runtime/plugins-src exactly (the sync scripts/vision-any.mjs contract)
//   * canonical runtime/plugins-src copy and the deployed runtime/dsh mirror
//     stay byte-identical for every shipped file (the sync discipline the
//     shell's boot redeploy depends on)
//   * the client bundle carries the inline-preview module and styles
//   * resolveImagePath maps both Windows and POSIX hint paths onto the stored
//     image route segments (pure, document-free)
//   * resolveImageRequest admits only store-shaped /vision-any/images paths
//     (no traversal, strict ext set) and lowercases case-insensitive matches
//   * serveStoredImage answers 404 JSON for invalid or evicted files
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'
import { randomBytes } from 'node:crypto'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const overlay = join(root, 'scripts', 'vision-any')
const canonical = join(root, 'runtime', 'plugins-src', 'dsh-vision-any')
const deployed = join(root, 'runtime', 'dsh', 'node_modules', 'dsh-vision-any')

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

// Overlay → fetched package: every desktop-local file must have been applied.
{
  const overlayFiles = [
    'client.js',
    'build.mjs',
    'src/index.js',
    'src/locales.js',
    'src/section.js',
    'src/styles.js',
    'src/preview.js',
  ]
  for (const file of overlayFiles) {
    const a = readFileSync(join(overlay, file), 'utf8')
    const b = readFileSync(join(canonical, file), 'utf8')
    assert(a === b, `${file} drifted between scripts/vision-any and plugins-src — run scripts/sync-vision-any.mjs`)
    console.log(`overlay ok: ${file}`)
  }
  for (const file of ['index.js', 'lib/routes.js']) {
    const a = readFileSync(join(overlay, 'overlay', file), 'utf8')
    const b = readFileSync(join(canonical, file), 'utf8')
    assert(a === b, `overlay/${file} drifted between scripts/vision-any and plugins-src — run scripts/sync-vision-any.mjs`)
    console.log(`overlay ok: overlay/${file}`)
  }
}

// Files the shell redeploys into the web profile; canonical and mirror must
// not drift (edits land in plugins-src, the mirror is the runtime's copy).
const SYNC_FILES = [
  'package.json',
  'index.js',
  'build.mjs',
  'client.js',
  'cordis.patch.yml',
  'lib/routes.js',
  'lib/store.js',
  'lib/admission.js',
  'src/index.js',
  'src/locales.js',
  'src/section.js',
  'src/styles.js',
  'src/preview.js',
  'README.md',
  'README.en.md',
]

for (const file of SYNC_FILES) {
  const a = readFileSync(join(canonical, file), 'utf8')
  const b = readFileSync(join(deployed, file), 'utf8')
  assert(a === b, `${file} drifted between plugins-src and runtime/dsh mirror — rebuild/sync the plugin`)
  console.log(`sync ok: ${file}`)
}

// The shipped client bundle must carry the preview module (the web profile
// serves client.js, not src/).
{
  const bundle = readFileSync(join(canonical, 'client.js'), 'utf8')
  for (const marker of ['installImagePreview', 'resolveImagePath', 'dva_imageBtn', 'vision-any/images']) {
    assert(bundle.includes(marker), `client.js is missing "${marker}" — rebuild with build.mjs`)
  }
  console.log('client bundle markers ok')
}

// preview.js is CommonJS source bundled by build.mjs but sits in an ESM
// package ("type": "module"), so materialize its exports through a vm like
// the browser loader does.
const previewExports = (() => {
  const source = readFileSync(join(canonical, 'src', 'preview.js'), 'utf8')
  const sandbox = { module: { exports: {} }, exports: {}, console }
  vm.runInNewContext(`${source}\n;module.exports`, sandbox)
  return sandbox.module.exports
})()

const { resolveImagePath } = previewExports

{
  const win = 'C:\\Users\\anixuil\\AppData\\Local\\Temp\\dsh-vision-any\\image3\\e001dc65d04d47bf.png'
  assert(JSON.stringify(resolveImagePath(win)) === JSON.stringify({ seqDir: 'image3', fileName: 'e001dc65d04d47bf.png' }), 'windows hint path did not resolve')
  const posix = '/tmp/dsh-vision-any/image12/abcd1234abcd1234.webp'
  assert(JSON.stringify(resolveImagePath(posix)) === JSON.stringify({ seqDir: 'image12', fileName: 'abcd1234abcd1234.webp' }), 'posix hint path did not resolve')
  const upper = 'D:\\x\\dsh-vision-any\\image2\\ABCDEF0123456789.JPG'
  assert(JSON.stringify(resolveImagePath(upper)) === JSON.stringify({ seqDir: 'image2', fileName: 'abcdef0123456789.jpg' }), 'case-insensitive normalization failed')
  assert(resolveImagePath('C:\\x\\image1\\e001dc65d04d47bf.jpeg') !== null, '.jpeg extension rejected')
  for (const bad of [
    'C:\\x\\image1\\e001dc65d04d47b.png', // 15 hex chars
    'C:\\x\\image1\\e001dc65d04d47bf.exe', // wrong extension
    'C:\\x\\imageX\\e001dc65d04d47bf.png', // bad seq dir
    'C:\\x\\e001dc65d04d47bf.png', // no seq dir
    '', // empty
  ]) {
    assert(resolveImagePath(bad) === null, `expected null for path: ${JSON.stringify(bad)}`)
  }
  console.log('resolveImagePath ok')
}

const routes = await import(pathToFileURL(join(deployed, 'lib', 'routes.js')))
const { resolveImageRequest, serveStoredImage } = routes

{
  const ok = resolveImageRequest('/vision-any/images/image3/e001dc65d04d47bf.png')
  assert(ok !== null, 'valid image path rejected')
  assert(ok.seqDir === 'image3' && ok.fileName === 'e001dc65d04d47bf.png', 'valid image path resolved wrong segments')
  assert(ok.filePath === join(require('node:os').tmpdir(), 'dsh-vision-any', 'image3', 'e001dc65d04d47bf.png'), 'filePath escaped the store dir')

  const upper = resolveImageRequest('/vision-any/images/IMAGE7/ABCDEF0123456789.GIF')
  assert(upper !== null && upper.seqDir === 'image7' && upper.fileName === 'abcdef0123456789.gif', 'case-insensitive request not normalized')

  for (const bad of [
    '/vision-any/images/image3/..%2f..%2fsecret', // encoded traversal
    '/vision-any/images/image3/../../Windows/win.ini', // plain traversal
    '/vision-any/images/image3/e001dc65d04d47bf.exe', // wrong extension
    '/vision-any/images/image3/e001dc65d04d47b.png', // short hash
    '/vision-any/images/notimage3/e001dc65d04d47bf.png', // bad seq dir
    '/vision-any/images/image3', // missing file
    '/vision-any/settings', // settings route
    '/vision-any/images/', // empty tail
  ]) {
    assert(resolveImageRequest(bad) === null, `expected rejection for path: ${bad}`)
  }
  console.log('resolveImageRequest ok')
}

{
  const collect = async (pathname) => {
    const res = new PassThrough()
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
    const chunks = []
    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    serveStoredImage(res, pathname)
    await new Promise((resolve, reject) => {
      res.on('end', resolve)
      res.on('error', reject)
    })
    return { status: res.status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }
  }
  // The temp image store can survive between runs, so a fixed hash is not a
  // reliable missing-file fixture on a developer machine.
  const missingHash = randomBytes(8).toString('hex')
  const missing = await collect(`/vision-any/images/image3/${missingHash}.png`)
  assert(missing.status === 404, `missing image expected 404, got ${missing.status}`)
  assert(missing.body.includes('image no longer stored'), 'missing image error body unexpected')
  const invalid = await collect('/vision-any/images/image3/../../x.png')
  assert(invalid.status === 404, `invalid path expected 404, got ${invalid.status}`)
  console.log('serveStoredImage 404 paths ok')
}

console.log('test-vision-any: all checks passed')
