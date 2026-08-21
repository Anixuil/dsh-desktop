// dsh-desktop-file-upload — Cordis host plugin mounted into the dsh web profile
// by DSH Desktop. Adds a file-upload button to the composer tool row so users
// can bring a local file into the conversation.
//
// Host half: persists uploaded files to a temp-dir store through a same-origin
// /file-upload route, and teaches the model (system prompt) to read the
// `[File #N "<name>" auto-saved to ...]` hint's path with its own `read` tool.
// The client half reads the picked file, POSTs it here, shows a file card in
// the composer dock, and appends the returned hint to the draft at send time.

import { ensureTmpDir } from './lib/store.js'
import { registerFileUploadRoutes } from './lib/routes.js'

export const name = 'dsh-desktop-file-upload'
export const inject = ['systemPrompt']

export function apply(ctx) {
  ensureTmpDir()
  registerFileUploadRoutes(ctx)
  registerSystemPrompt(ctx)
}

function registerSystemPrompt(ctx) {
  if (typeof ctx.systemPrompt?.section !== 'function') return
  ctx.systemPrompt.section({
    name: 'dsh-desktop-file-upload:instructions',
    order: 110,
    text: [
      'When a user message contains a file hint like "[File #N "<name>" auto-saved to <path>]", the user uploaded a file and it was saved to that absolute path.',
      'Use the read tool with that exact path to read the file\'s full content. Do NOT claim you can read the file directly from the hint text.',
    ].join('\n'),
  })
}
