// dsh-vision-any overlay — client bundle build (desktop-local half).
// Bundles src/ into client.js with the shared zero-dependency bundler; the
// artifact is deployed into the fetched plugin package by
// scripts/sync-vision-any.mjs (or by fetch-runtime.mjs step [4/4]).
//
// This same file is deployed into the package (runtime/plugins-src/
// dsh-vision-any/build.mjs) so an in-tree rebuild keeps working; the bundler
// module is resolved relative to either location.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const candidates = [
  // scripts/vision-any/build.mjs -> scripts/lib/
  resolve(here, '..', 'lib', 'build-client-bundle.mjs'),
  // runtime/plugins-src/dsh-vision-any/build.mjs -> repo scripts/lib/
  resolve(here, '..', '..', '..', 'scripts', 'lib', 'build-client-bundle.mjs'),
]
const bundler = candidates.find((candidate) => existsSync(candidate))
if (bundler === undefined) {
  throw new Error(`build-client-bundle.mjs not found next to ${here}; tried: ${candidates.join(', ')}`)
}
const { buildClientBundle } = await import(pathToFileURL(bundler))

const pkgDir = here

// Fixed module order keeps the emitted bundle byte-stable between runs.
buildClientBundle({
  pkgDir,
  files: [
    'styles.js',
    'message.js',
    'locales.js',
    'section.js',
    'preview.js',
    'index.js',
  ],
})
