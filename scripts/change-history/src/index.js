// dsh-desktop-change-history — web client module entry.
//
// Registered as a native settings page (`settings.section`, the same seat the
// Models/General sections use): appears in the settings nav as 变更历史 and
// renders the timeline from ./section.js. Implementation lives in the modules
// under src/.
const { ChangeHistorySection, ChangeRow, ConfirmModal } = require('./section.js');
const { ChangeMutationRow } = require('./mutation-row.js');
const { FileViewerOverlay } = require('./file-viewer.js');
const { zh, en } = require('./locales.js');

/** Dictionary namespace owned by this plugin. */
const NS = 'changeHistory';

/** Services required from the client root context. */
const inject = ['slots', 'locale'];

/**
 * @param ctx - client root context (slots/locale services).
 */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-desktop-change-history: dictionaries');
  const t = ctx.locale.bind(NS);
  // 变更历史 settings page (aggregate timeline + rollback).
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'change-history',
        order: 21,
        label: () => t('nav'),
        inject: () => ({ t }),
      },
      ChangeHistorySection,
    ),
  );
  // Inline write/edit rows: shadow the shipped file-mutation row (priority -1,
  // lowest renders) with the review/view/revert actions.
  ctx.slots.inject('tool.call.toolview', function* () {
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'edit', priority: -1, locale: NS }, ChangeMutationRow);
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'write', priority: -1, locale: NS }, ChangeMutationRow);
  });
  // Built-in side file viewer: the inline 查看 action opens it via the shared
  // store in ./file-viewer.js (frame-wide shell.overlay list slot).
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'change-history-file-viewer', order: 100, locale: NS },
      FileViewerOverlay,
    ),
  );
}

exports.apply = apply;
exports.inject = inject;
// Pure views re-exported for fixture-driven tests.
exports.views = { ChangeHistorySection, ChangeRow, ConfirmModal, ChangeMutationRow, FileViewerOverlay };
