require('./styles.js')
const { WebSearchSection } = require('./section.js')
const { NS, zh, en } = require('./locales.js')

const inject = ['slots', 'locale', 'connection', 'remote']

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-desktop-web-search: dictionaries')
  const t = ctx.locale.bind(NS)
  const connection = ctx.get('connection')
  const remote = ctx.get('remote')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'web-search',
    order: 4,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({
      t,
      isLoopback: connection.isLoopback,
      subscribe: (handler) => {
        const offDocument = remote.$on('settings/document-updated', handler)
        const offReset = ctx.on('connection/reset', handler)
        return () => { offDocument(); offReset() }
      },
    }),
  }, WebSearchSection))
}

exports.apply = apply
exports.inject = inject
exports.views = { WebSearchSection }
