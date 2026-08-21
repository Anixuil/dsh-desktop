// dsh-desktop-file-upload — client bundle build (thin wrapper).
// Bundles src/ into client.js with the shared zero-dependency bundler.
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildClientBundle } from '../lib/build-client-bundle.mjs'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

// Fixed module order keeps the emitted bundle byte-stable between runs.
buildClientBundle({
  pkgDir,
  files: [
    'styles.js',
    'message.js',
    'locales.js',
    'meta.js',
    'store.js',
    'open.js',
    'button.js',
    'dock.js',
    'preview.js',
    'index.js',
  ],
})
