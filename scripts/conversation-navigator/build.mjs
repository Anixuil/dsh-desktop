// dsh-desktop-conversation-navigator - deterministic client bundle build.
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildClientBundle } from '../lib/build-client-bundle.mjs'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

buildClientBundle({
  pkgDir,
  files: [
    'model.js',
    'locales.js',
    'styles.js',
    'navigator.js',
    'index.js',
  ],
})
