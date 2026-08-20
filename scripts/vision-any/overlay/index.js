// dsh-vision-any — paste images into text-only DeepSeek Harness models and
// analyze them with any OpenAI-compatible, Anthropic, or Gemini vision API.
//
// It combines:
//   1. prompt-admission override (pasted images become local path hints)
//   2. a `vision` tool that sends the images to a configurable VLM backend
//   3. the `vision-any` settings namespace + /vision-any/settings routes that
//      back the web GUI's 视觉模型 (vision model) settings section

import { buildBaseConfig, validateConfig, resolveProviderConfig } from './lib/config.js'
import { VISION_SETTINGS_NAMESPACE, VISION_SETTINGS_SCHEMA } from './lib/settings.js'
import { registerSettingsRoutes } from './lib/routes.js'
import { ensureTmpDir, setMaxImages, TMP_DIR } from './lib/store.js'
import { buildVisionTool } from './lib/tool.js'
import { installPromptAdmission } from './lib/admission.js'

export const name = 'dsh-vision-any'
export const inject = ['tools', 'llm', 'systemPrompt']

export function apply(ctx, rowConfig = {}) {
  const entry = buildBaseConfig(rowConfig)
  validateConfig(entry)
  ensureTmpDir()
  setMaxImages(entry.maxImages)

  // GUI-configurable layer: the `vision-any` settings namespace (web settings
  // panel → 视觉模型 section). Only user-written fields land in it, so the
  // config file / env / defaults keep working for everything the GUI leaves
  // untouched; the thunk reads the live scope on every tool call.
  let settingsSource = () => undefined
  let settingsHandle = null
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(VISION_SETTINGS_NAMESPACE, VISION_SETTINGS_SCHEMA, {})
    settingsHandle = { service: sctx.settings, scope }
    settingsSource = () => scope.get()
    sctx.effect(() => () => {
      settingsHandle = null
      settingsSource = () => undefined
    }, 'dsh-vision-any: settings scope')
  })
  registerSettingsRoutes(ctx, VISION_SETTINGS_NAMESPACE, () => settingsHandle)

  // Re-read config file / env / settings on every call so changes apply
  // without restart.
  const getConfig = () => resolveProviderConfig(buildBaseConfig(rowConfig, settingsSource()))

  if (entry.systemPrompt !== false) registerSystemPrompt(ctx, getConfig)
  registerVisionTool(ctx, getConfig, entry.toolName)
  installPromptAdmission(ctx, getConfig)
}

function registerSystemPrompt(ctx, getConfig) {
  if (typeof ctx.systemPrompt?.section !== 'function') return
  const toolName = getConfig().toolName || 'vision'
  ctx.systemPrompt.section({
    name: 'dsh-vision-any:instructions',
    order: 110,
    text: [
      'The active model is text-only and CANNOT process images directly.',
      `When a user message contains an image, dsh-vision-any saves it under ${TMP_DIR} and replaces the image with a hint like "[Image #N auto-saved to ...]" (the chat UI renders the saved image inline for the user, but you only receive the hint text).`,
      `To analyze the image, call the \`${toolName}\` tool with that exact path. Do NOT claim you can see the image directly, and do NOT claim the image failed to load.`,
    ].join('\n'),
  })
}

function registerVisionTool(ctx, getConfig, preferred) {
  const tryRegister = (toolName) => {
    try {
      ctx.tools.register(buildVisionTool(getConfig, toolName))
      return true
    } catch (error) {
      return error
    }
  }
  const first = tryRegister(preferred || 'vision')
  if (first === true) return
  const fallback = 'dsh_vision'
  if ((preferred || 'vision') !== fallback && /already|duplicate/i.test(String(first))) {
    const second = tryRegister(fallback)
    if (second === true) {
      console.error(`[dsh-vision-any] tool name "${preferred}" is taken by the host; registered as "${fallback}" instead`)
      return
    }
  }
  console.error(`[dsh-vision-any] vision tool registration skipped: ${first}`)
}
