// dsh-desktop-change-history — client bundle build (thin wrapper).
// Bundles src/ into client.js with the shared zero-dependency bundler.
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildClientBundle } from '../lib/build-client-bundle.mjs'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

// Fixed module order keeps the emitted bundle byte-stable between runs.
buildClientBundle({
  pkgDir,
  files: [
    'contract.js',
    'api.js',
    'locales.js',
    'use-change-history.js',
    'styles.js',
    'message.js',
    'file-viewer.js',
    'approval-panel.js',
    'mutation-row.js',
    'section.js',
    'index.js',
  ],
})
