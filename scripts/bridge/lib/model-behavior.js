const SETTINGS_NAMESPACE = 'desktop-model-behavior'
const PROMPT_SECTION = 'dsh-desktop:user-system-prompt'
const PROMPT_MAX_CHARS = 20000

function normalizeModelBehavior(input) {
  const systemPrompt = typeof input?.systemPrompt === 'string' ? input.systemPrompt : ''
  if (systemPrompt.length > PROMPT_MAX_CHARS) {
    throw new RangeError(`system prompt exceeds ${String(PROMPT_MAX_CHARS)} characters`)
  }

  const temperature = input?.temperature
  if (temperature === undefined || temperature === null) return { systemPrompt }
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new RangeError('temperature must be a finite number between 0 and 2')
  }
  return { systemPrompt, temperature: Math.round(temperature * 10) / 10 }
}

function applyModelTemperature(config, temperature) {
  if (temperature === undefined) {
    const { temperature: _previous, ...modelDefaults } = config
    return modelDefaults
  }
  return { ...config, temperature }
}

/** Register live user model-behavior settings against DSH's own services. */
export function registerModelBehavior(ctx) {
  let settingsScope = null

  ctx.inject(['settings', 'systemPrompt'], async (behaviorCtx) => {
    const { default: z } = await import('@deepseek-ai/schemastery')
    const scope = behaviorCtx.settings.register(
      SETTINGS_NAMESPACE,
      z.object({
        systemPrompt: z.string().max(PROMPT_MAX_CHARS).default(''),
        temperature: z.number().step(0.1).min(0).max(2),
      }),
      { base: { systemPrompt: '' }, applies: 'live' },
    )

    settingsScope = scope
    behaviorCtx.systemPrompt.section({
      name: PROMPT_SECTION,
      order: 10,
      text: () => scope.get().systemPrompt.trim(),
    })
    behaviorCtx.on('agent/request', async (_payload, next) => {
      const config = await next()
      return applyModelTemperature(config, scope.get().temperature)
    })
    behaviorCtx.effect(() => () => {
      if (settingsScope === scope) settingsScope = null
    }, 'dsh-desktop-bridge: detach model behavior settings')
  })

  const requireScope = () => {
    if (settingsScope === null) throw new Error('model behavior settings are not ready')
    return settingsScope
  }

  return {
    read() {
      return normalizeModelBehavior(requireScope().get())
    },
    async save(input) {
      const next = normalizeModelBehavior(input)
      await requireScope().replace(next)
      return normalizeModelBehavior(requireScope().get())
    },
  }
}

export {
  SETTINGS_NAMESPACE,
  PROMPT_MAX_CHARS,
  normalizeModelBehavior,
  applyModelTemperature,
}
