// dsh-desktop-session-manager — web client module entry.
//
// Registered as a native settings page (`settings.section`, the same seat the
// Models/General sections use): appears in the settings nav as 会话管理 and
// renders the section from ./section.js (two row-card groups + delete
// confirmation). Implementation lives in the modules under src/.
const { SessionManagerSection, SessionRow } = require('./section.js');
const { zh, en } = require('./locales.js');

/** Dictionary namespace owned by this plugin. */
const NS = 'sessionManager';

/** Services required from the client root context. */
const inject = ['slots', 'locale'];

/**
 * @param ctx - client root context (slots/locale services; sessions via ctx.get).
 */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-desktop-session-manager: dictionaries');
  const t = ctx.locale.bind(NS);
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'session-manager',
        order: 20,
        label: () => t('nav'),
        inject: () => ({
          t,
          // client runtime sessions service: current-session tracking + open()
          sessions: ctx.get?.('sessions') ?? null,
          // client runtime workspaces service: live archive set (merged onto
          // the server rows so archived sessions never read as missing)
          workspaces: ctx.get?.('workspaces') ?? null,
        }),
      },
      SessionManagerSection,
    ),
  );
}

exports.apply = apply;
exports.inject = inject;
// Pure section/row + merge helper re-exported for fixture-driven tests.
const { mergeArchivedFlags } = require('./use-session-manager.js');
exports.views = { SessionManagerSection, SessionRow, mergeArchivedFlags };
