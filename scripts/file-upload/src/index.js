// dsh-desktop-file-upload — web client module entry.
//
// Registers a file-upload button into the composer's left tool row
// (`conversation.input.left`) and a pending-file card list into the dock row
// above the composer (`conversation.input.dock`). The button reads a picked
// file, POSTs it to the host store, and records the returned hint in the
// client pending-file store; the dock renders each file as a card (icon +
// name + format) and appends the hint to the draft at send time. A
// MutationObserver (preview.js) turns the hint text in sent messages back
// into file cards.
require('./styles.js')
const { FileUploadButton } = require('./button.js')
const { FileDock } = require('./dock.js')
const { installFilePreview } = require('./preview.js')
const { zh, en, NS } = require('./locales.js')

/** Services required from the client root context. */
const inject = ['slots', 'locale']

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-desktop-file-upload: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.effect(() => installFilePreview(), 'dsh-desktop-file-upload: file preview')

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'file-upload',
    order: 10,
    locale: NS,
    inject: () => ({ t }),
  }, FileUploadButton))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'file-upload',
    order: 5,
    locale: NS,
    inject: () => ({ t }),
  }, FileDock))
}

exports.apply = apply
exports.inject = inject
exports.views = { FileUploadButton, FileDock }
