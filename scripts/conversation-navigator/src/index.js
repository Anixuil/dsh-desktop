// dsh-desktop-conversation-navigator - frame-wide local conversation outline.
const { ConversationNavigator, computeLayout } = require('./navigator.js')
const model = require('./model.js')
const { zh, en } = require('./locales.js')

const NS = 'conversationNavigator'
const inject = ['slots', 'locale', 'sessions']

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-desktop-conversation-navigator: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'conversation-navigator',
    order: 20,
    locale: NS,
    inject: () => ({ sessions: ctx.sessions, t }),
  }, ConversationNavigator))
}

exports.apply = apply
exports.inject = inject
exports.helpers = { ...model, computeLayout }
exports.views = { ConversationNavigator }
