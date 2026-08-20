// dsh-vision-any — web client module entry.
//
// Registers the 视觉模型 (vision model) settings section into the web
// settings panel (`settings.section` slot, id "vision-any", right after the
// Models section). The section edits the `vision-any` settings namespace the
// host half reads on every vision-tool call, so saves apply immediately.
//
// Also installs the inline image preview (preview.js): every `[Image #N
// auto-saved to ...]` hint the host admission wrote into a message renders as
// an image card served from /vision-any/images, with a click-to-open
// lightbox. The model-visible hint text stays untouched.
require('./styles.js')
const { VisionSection } = require('./section.js')
const { NS, zh, en } = require('./locales.js')
const { installImagePreview } = require('./preview.js')

/** Services required from the client root context. */
const inject = ['slots', 'locale', 'connection', 'remote']

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-vision-any: dictionaries')
  const t = ctx.locale.bind(NS)
  const connection = ctx.get('connection')
  const remote = ctx.get('remote')
  ctx.effect(() => installImagePreview(t), 'dsh-vision-any: image preview')
  const injected = () => ({
    t,
    isLoopback: connection.isLoopback,
    // Refresh the section whenever the host document moves (own saves
    // included) or the connection resets.
    subscribe: (handler) => {
      const offDocument = remote.$on('settings/document-updated', handler)
      const offReset = ctx.on('connection/reset', handler)
      return () => {
        offDocument()
        offReset()
      }
    },
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'vision-any',
    order: 12,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, VisionSection))
}

exports.apply = apply
exports.inject = inject
exports.views = { VisionSection }
