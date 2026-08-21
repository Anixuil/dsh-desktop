// dsh-desktop-web-search client bundle build (thin wrapper).
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildClientBundle } from '../lib/build-client-bundle.mjs'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

buildClientBundle({
  pkgDir,
  files: ['styles.js', 'message.js', 'locales.js', 'section.js', 'index.js'],
})
